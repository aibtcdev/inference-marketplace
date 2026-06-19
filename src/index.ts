// BigInt.toJSON polyfill for JSON.stringify compatibility
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { cors } from 'hono/cors';
import { x402Middleware, x402DynamicMiddleware } from './x402-middleware';
import type { X402Context, TokenType } from './x402-middleware';
import { callUpstream, proxyChatCompletion } from './upstream';
import type { ChatCompletionBody } from './upstream';
import { getModel, MODELS, DEFAULT_MODEL } from './catalog';
import { getProvider } from './registry';
import * as directory from './directory';
import { checkEndpoint, verifyProvider } from './health';
import { REGISTRATION_SCHEMA } from './schema';
import { validateHfModel } from './hf';
import { quotePrice, realizedCostUsd, estimateTokens, usdToBaseUnits } from './pricing';
import type { Quote } from './pricing';

type Env = {
  RECIPIENT_ADDRESS: string;
  NETWORK: string;
  RELAY_URL: string;
  /** KV namespace storing the external provider directory. */
  PROVIDERS: KVNamespace;
  /** Base URL of the OpenAI-compatible upstream (HF Inference Endpoint / vLLM). */
  UPSTREAM_BASE_URL: string;
  /** Bearer token for the upstream (HF token / vLLM api-key). */
  UPSTREAM_API_KEY: string;
  /** Optional: force the model name sent upstream (single-model endpoints like
   *  an HF Inference Endpoint or Ollama serve one model under their own id). */
  UPSTREAM_MODEL?: string;
  /** Multiple of serving cost charged to the agent. Default 1.5 (50% margin). */
  PRICE_MARKUP?: string;
  /** DEV-ONLY: 'true' bypasses payment on non-mainnet (see x402-middleware). */
  SKIP_PAYMENT?: string;
};

type Variables = {
  x402?: X402Context;
  quote?: Quote;
};

function markupFrom(env: Env): number | undefined {
  const m = Number(env.PRICE_MARKUP);
  return Number.isFinite(m) && m > 0 ? m : undefined;
}

/** Concatenated text of the chat messages, for upfront prompt-token sizing. */
function promptTextOf(body: ChatCompletionBody): string {
  return (body.messages ?? [])
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join(' ');
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// CORS with x402 headers exposed
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['payment-signature', 'X-PAYMENT-TOKEN-TYPE', 'Authorization', 'Content-Type'],
  exposeHeaders: ['payment-required', 'payment-response', 'X-PAYER-ADDRESS'],
}));

// Fail fast on the paid endpoints if required secrets are missing. Free
// discovery routes (info, health, catalog, providers) stay available.
app.use('/v1/chat', requireSecrets);
app.use('/v1/chat/*', requireSecrets);

async function requireSecrets(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  next: Next,
) {
  const missing: string[] = [];
  if (!c.env.RECIPIENT_ADDRESS) missing.push('RECIPIENT_ADDRESS');
  if (!c.env.UPSTREAM_BASE_URL) missing.push('UPSTREAM_BASE_URL');
  if (!c.env.UPSTREAM_API_KEY) missing.push('UPSTREAM_API_KEY');
  if (missing.length) {
    return c.json({
      error: 'Server configuration error',
      message: `Missing required config: ${missing.join(', ')}`,
      hint: missing.map((s) => `wrangler secret put ${s}`).join(' && '),
    }, 503);
  }
  await next();
}

// ---------------------------------------------------------------------------
// Discovery (free)
// ---------------------------------------------------------------------------

app.get('/', (c) => {
  return c.json({
    service: 'aibtc-inference-marketplace',
    description: 'Pay-per-request AI inference settled in sBTC / USDCx on Stacks.',
    version: '1.0.0',
    phase: 1,
    network: c.env.NETWORK || 'testnet',
    payment: {
      tokens: ['sBTC', 'USDCx', 'STX'],
      scheme: 'x402',
      header: 'X-PAYMENT',
      tokenTypeHeader: 'X-PAYMENT-TOKEN-TYPE',
      flow: 'Request -> 402 requirements -> sign (no broadcast) -> retry with X-PAYMENT -> settle via relay -> inference',
    },
    endpoints: {
      models: 'GET /v1/models',
      providers: 'GET /v1/providers',
      chatCompletions: 'POST /v1/chat/completions  (OpenAI-compatible, dynamic price by model)',
      chat: 'POST /v1/chat  (simple prompt, cheap tier)',
      registerProvider: 'POST /v1/providers  (Phase 2)',
      feedback: 'POST /v1/feedback  (Phase 3, reputation)',
    },
  });
});

app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString(), network: c.env.NETWORK || 'testnet' });
});

// Model catalog with LIVE, dynamic pricing. Each model is priced for a
// reference 1k-output-token call so callers can compare; the real charge is
// quoted per request from the actual prompt + max_tokens.
app.get('/v1/models', async (c) => {
  const markup = markupFrom(c.env);
  const data = await Promise.all(
    MODELS.map(async (m) => {
      const q = await quotePrice({
        modelId: m.id,
        costPer1kUsd: m.costPer1kUsd,
        promptText: '',
        maxTokens: 1000,
        tokenType: 'sBTC',
        markup,
      });
      return {
        id: m.id,
        name: m.name,
        tier: m.tier,
        contextLength: m.contextLength,
        providerId: m.providerId,
        bestFor: m.bestFor,
        // reference price for ~1k output tokens
        referencePrice: {
          usd: Number(q.priceUsd.toFixed(6)),
          sats: q.amount,
          markup: q.markup,
          btcUsd: q.btcUsd,
        },
      };
    }),
  );
  return c.json({ object: 'list', pricedFor: '1000 output tokens', data });
});

// Provider directory (supply side) — external providers registered via the UI.
app.get('/v1/providers', async (c) => {
  const data = await directory.listProviders(c.env.PROVIDERS);
  return c.json({ object: 'list', data });
});

// ---------------------------------------------------------------------------
// Inference (paid via x402)
// ---------------------------------------------------------------------------

/**
 * OpenAI-compatible chat completions. Price is resolved dynamically from the
 * requested `model` and chosen payment token, then settled before we route the
 * request to the model's provider.
 */
app.post('/v1/chat/completions',
  x402DynamicMiddleware(async (c, tokenType: TokenType) => {
    let body: ChatCompletionBody;
    try {
      body = await c.req.json<ChatCompletionBody>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const model = getModel(body.model);
    if (!model) {
      return c.json({
        error: `Unknown model: ${body.model ?? '(none)'}`,
        hint: 'GET /v1/models for the catalog',
      }, 400);
    }
    // Dynamic quote: serving cost x markup, converted to the token at the live rate.
    const quote = await quotePrice({
      modelId: model.id,
      costPer1kUsd: model.costPer1kUsd,
      promptText: promptTextOf(body),
      maxTokens: body.max_tokens ?? 1024,
      tokenType,
      markup: markupFrom(c.env),
    });
    c.set('quote', quote);
    return {
      amount: quote.amount,
      tokenType,
      extra: {
        pricing: {
          type: 'dynamic',
          estimate: { model: model.id, estimatedCostUsd: quote.priceUsd.toFixed(6) },
        },
      },
    };
  }),
  async (c) => {
    const payment = c.get('x402');
    const body = await c.req.json<ChatCompletionBody>();
    const model = getModel(body.model)!; // validated in middleware
    const provider = getProvider(model.providerId);

    if (!provider || provider.status !== 'live') {
      return c.json({ error: `No live provider for model ${model.id}` }, 503);
    }

    // Phase 2: external providers serve their own x402 endpoint; the gateway
    // forwards and settles to their payout address. Not yet enabled.
    if (provider.kind === 'external') {
      return c.json({
        error: 'External provider routing not enabled yet (Phase 2)',
        provider: provider.id,
        endpoint: provider.endpoint,
      }, 501);
    }

    // House provider -> our OpenAI-compatible upstream (HF endpoint / vLLM).
    const upstream = await proxyChatCompletion(
      c.env.UPSTREAM_BASE_URL,
      c.env.UPSTREAM_API_KEY,
      { ...body, model: c.env.UPSTREAM_MODEL || model.upstreamModel },
    );
    const quote = c.get('quote');

    const upstreamObj = (typeof upstream.json === 'object' && upstream.json) ? upstream.json as Record<string, unknown> : {};
    const usage = upstreamObj.usage as { total_tokens?: number } | undefined;
    // Self-hosted upstreams report tokens, not a dollar cost — derive it.
    const servingCostUsd = usage?.total_tokens != null
      ? Number(realizedCostUsd(usage.total_tokens, model.costPer1kUsd).toFixed(6))
      : null;

    return c.json({
      ...upstreamObj,
      _marketplace: {
        model: model.id,
        tier: model.tier,
        provider: provider.id,
        // What the agent paid us — the dynamic quote (cost x markup, live rate).
        pricePaid: quote && {
          amount: quote.amount,
          tokenType: quote.tokenType,
          priceUsd: Number(quote.priceUsd.toFixed(6)),
          markup: quote.markup,
          btcUsd: quote.btcUsd,
        },
        // What this call cost the house to serve (tokens x costPer1kUsd).
        // pricePaid.priceUsd - servingCostUsd ~= realized margin on this call.
        servingCostUsd,
        tokens: usage?.total_tokens ?? null,
        payment: { txId: payment?.settleResult?.transaction, payer: payment?.payerAddress },
      },
    }, upstream.status as 200);
  },
);

// Simple prompt endpoint for quick demos — fixed price, default model.
app.post('/v1/chat',
  x402Middleware({ amount: '1000', tokenType: 'sBTC' }),
  async (c) => {
    const payment = c.get('x402');
    const body = await c.req.json<{ prompt?: string; message?: string; text?: string }>();
    const userInput = body.prompt || body.message || body.text || '';
    if (!userInput) {
      return c.json({ error: 'Missing required field: prompt, message, or text' }, 400);
    }

    const result = await callUpstream(c.env.UPSTREAM_BASE_URL, c.env.UPSTREAM_API_KEY, {
      model: c.env.UPSTREAM_MODEL || DEFAULT_MODEL.upstreamModel,
      systemPrompt: 'You are a helpful AI assistant.',
      userMessage: userInput,
    });

    return c.json({
      result: result.content,
      model: DEFAULT_MODEL.id,
      usage: result.usage,
      pricePaid: { amount: '1000', tokenType: 'sBTC' },
      payment: { txId: payment?.settleResult?.transaction, sender: payment?.payerAddress },
    });
  },
);

// ---------------------------------------------------------------------------
// Supply side & reputation (Phase 2 / 3 seams)
// ---------------------------------------------------------------------------

// The structured registration contract. Providers host a schema.json matching
// this; agents validate against it before submitting.
app.get('/v1/schema', (c) => c.json(REGISTRATION_SCHEMA));

// Register a provider. Accepts either:
//   - { manifestUrl }            → fetch that schema.json
//   - { endpoint }               → fetch {endpoint}/schema.json
//   - inline { name, endpoint, payoutAddress, models[] }  (manual)
// Then VERIFIES the endpoint is reachable AND actually serves inference before
// confirming. Unverified endpoints are not listed.
app.post('/v1/providers', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Resolve the registration from a hosted schema.json when possible.
  let reg = body as unknown as directory.ProviderInput;
  const explicit = typeof body.manifestUrl === 'string' ? (body.manifestUrl as string) : null;
  const derived = !explicit && typeof body.endpoint === 'string' && !body.models
    ? `${(body.endpoint as string).replace(/\/$/, '')}/schema.json`
    : null;
  const manifestUrl = explicit || derived;
  if (manifestUrl) {
    try {
      const mr = await fetch(manifestUrl, { signal: AbortSignal.timeout(8000) });
      if (mr.ok) {
        const manifest = (await mr.json()) as Record<string, unknown>;
        reg = { ...manifest, endpoint: (manifest.endpoint as string) || (body.endpoint as string) } as unknown as directory.ProviderInput;
      } else if (explicit) {
        return c.json({ error: `Couldn't fetch schema.json (HTTP ${mr.status})` }, 400);
      }
    } catch (e) {
      if (explicit) return c.json({ error: `Couldn't fetch schema.json: ${e instanceof Error ? e.message : String(e)}` }, 400);
    }
  }

  // Validate every model id against Hugging Face (real + text-generation +
  // commercial license). Rejects made-up names and non-commercial weights.
  const modelIds = (reg.models ?? []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
  if (modelIds.length === 0) return c.json({ error: 'at least one model id is required' }, 400);
  const hfChecks = await Promise.all(modelIds.map((id) => validateHfModel(id)));
  const badModel = hfChecks.find((r) => !r.valid);
  if (badModel) return c.json({ error: badModel.error }, 400);

  // Validate + store (status pending). Allow http://localhost only off mainnet.
  reg.allowLocal = (c.env.NETWORK || 'testnet') !== 'mainnet';
  let provider;
  try {
    provider = await directory.registerProvider(c.env.PROVIDERS, reg);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }

  // Gate: verify reachable AND functional before confirming (using the shared
  // key if the endpoint is secured). Roll back if not.
  const v = await verifyProvider(provider.endpoint, reg.apiKey);
  if (!v.ok) {
    await directory.removeProvider(c.env.PROVIDERS, provider.id);
    return c.json({ error: v.error, reachable: v.reachable, functional: v.functional }, 400);
  }
  const updated = await directory.setHealth(c.env.PROVIDERS, provider.id, v.health);
  return c.json(
    { provider: updated ?? provider, verification: { reachable: true, functional: true, servedModel: v.servedModel, sample: v.sample } },
    201,
  );
});

// Re-run the health check for one provider on demand.
app.post('/v1/providers/:id/check', async (c) => {
  const id = c.req.param('id');
  const provider = await directory.getProvider(c.env.PROVIDERS, id);
  if (!provider) return c.json({ error: 'Provider not found' }, 404);
  const health = await checkEndpoint(provider.endpoint);
  const updated = await directory.setHealth(c.env.PROVIDERS, id, health);
  return c.json({ provider: updated });
});

// Remove a provider (operator/self-service).
app.delete('/v1/providers/:id', async (c) => {
  const ok = await directory.removeProvider(c.env.PROVIDERS, c.req.param('id'));
  return c.json({ removed: ok }, ok ? 200 : 404);
});


// Test console: proxy a chat completion to a provider's endpoint so anyone can
// try it from the UI (server-side call avoids browser CORS). Auto-discovers the
// provider's served model name. If the provider is x402-gated it returns 402.
app.post('/v1/providers/:id/test', async (c) => {
  const provider = await directory.getProvider(c.env.PROVIDERS, c.req.param('id'));
  if (!provider) return c.json({ error: 'Provider not found' }, 404);

  let body: { prompt?: string; model?: string; max_tokens?: number } = {};
  try { body = await c.req.json(); } catch { /* defaults */ }
  const prompt = body.prompt?.trim() || 'In one sentence, what is Bitcoin?';

  const key = (await directory.getProviderKey(c.env.PROVIDERS, provider.id)) ?? '';
  const auth: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};

  // Discover the served model name (e.g. "qwen2.5:7b") from the provider's /models.
  let model = body.model;
  if (!model) {
    try {
      const mr = await fetch(`${provider.endpoint}/models`, { headers: auth, signal: AbortSignal.timeout(8000) });
      const md = (await mr.json()) as { data?: Array<{ id?: string }> };
      model = md?.data?.[0]?.id || provider.models[0]?.id;
    } catch {
      model = provider.models[0]?.id;
    }
  }

  const started = Date.now();
  try {
    const r = await fetch(`${provider.endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: body.max_tokens ?? 256 }),
      signal: AbortSignal.timeout(30000),
    });
    const latencyMs = Date.now() - started;
    const j = (await r.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: unknown;
      error?: unknown;
    };
    if (r.status === 402) return c.json({ error: 'This provider requires x402 payment to run inference.', paymentRequired: true, model, latencyMs });
    if (!r.ok) return c.json({ error: typeof j.error === 'string' ? j.error : `provider returned HTTP ${r.status}`, model, latencyMs });
    return c.json({ model, content: j.choices?.[0]?.message?.content ?? '', usage: j.usage ?? null, latencyMs });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e), model, latencyMs: Date.now() - started });
  }
});

// PAID routing proxy. A client pays here; the gateway settles the x402 payment
// DIRECTLY to the provider's wallet (payTo = provider.payoutAddress, non-
// custodial), then forwards the request to the provider's endpoint. This is how
// a bare provider gets monetized without running x402 themselves.
const DEFAULT_PRICE_PER_MTOK_USD = 0.20;

app.post('/v1/route/:id/chat/completions',
  x402DynamicMiddleware(async (c, tokenType: TokenType) => {
    const provider = await directory.getProvider(c.env.PROVIDERS, c.req.param('id') ?? '');
    if (!provider) return c.json({ error: 'Provider not found' }, 404);
    if (provider.status === 'down') return c.json({ error: 'Provider is currently down' }, 503);

    let body: ChatCompletionBody;
    try { body = await c.req.json<ChatCompletionBody>(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }

    const model = provider.models.find((m) => m.id === body.model) || provider.models[0];
    if (!model) return c.json({ error: 'Provider serves no models' }, 400);

    // Price = provider's declared per-token rate × estimated tokens. The client
    // pays the provider directly; the marketplace takes no custody.
    const pricePerMTok = model.pricePerMTokenUsd ?? DEFAULT_PRICE_PER_MTOK_USD;
    const estTokens = estimateTokens(promptTextOf(body)) + (body.max_tokens ?? 512);
    const usd = (estTokens / 1_000_000) * pricePerMTok;
    const amount = await usdToBaseUnits(usd, tokenType);

    return {
      amount,
      tokenType,
      payTo: provider.payoutAddress,
      extra: { pricing: { type: 'dynamic', estimate: { model: model.id, provider: provider.id, estimatedCostUsd: usd.toFixed(6) } } },
    };
  }),
  async (c) => {
    const provider = await directory.getProvider(c.env.PROVIDERS, c.req.param('id'));
    if (!provider) return c.json({ error: 'Provider not found' }, 404);
    const payment = c.get('x402');
    const body = await c.req.json<ChatCompletionBody>();

    // Forward with the provider's shared key (only the gateway holds it).
    const key = (await directory.getProviderKey(c.env.PROVIDERS, provider.id)) ?? '';

    // Map the requested model id to the provider's actual served model name.
    let upstreamModel = body.model;
    try {
      const mr = await fetch(`${provider.endpoint}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(8000) });
      const md = (await mr.json()) as { data?: Array<{ id?: string }> };
      upstreamModel = md?.data?.[0]?.id || body.model;
    } catch { /* keep requested model */ }

    const upstream = await proxyChatCompletion(provider.endpoint, key, { ...body, model: upstreamModel });
    const upstreamObj = (typeof upstream.json === 'object' && upstream.json) ? upstream.json as Record<string, unknown> : {};

    return c.json({
      ...upstreamObj,
      _marketplace: {
        provider: provider.id,
        paidTo: provider.payoutAddress,
        payment: { txId: payment?.settleResult?.transaction, payer: payment?.payerAddress },
      },
    }, upstream.status as 200);
  },
);

// Submit reputation feedback for a provider (Phase 3). On-chain via the
// ERC-8004 reputation registry. Documented here as the integration point.
app.post('/v1/feedback', async (c) => {
  return c.json({
    error: 'Reputation feedback not enabled yet (Phase 3)',
    howItWorks: 'Agents score a provider after inference; scores are written to the ERC-8004 reputation registry and read back via reputation_get_summary(agentId) to rank competing providers.',
    contract: 'reputation_give_feedback(agentId, rating, ...)',
  }, 501);
});

// Continuous monitoring: re-check every provider's endpoint on the cron
// schedule (see wrangler.jsonc triggers), updating live/degraded/down status.
async function scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  ctx.waitUntil((async () => {
    const providers = await directory.listProviders(env.PROVIDERS);
    await Promise.all(
      providers.map(async (p) => {
        const key = p.secured ? await directory.getProviderKey(env.PROVIDERS, p.id) : undefined;
        const health = await checkEndpoint(p.endpoint, key);
        await directory.setHealth(env.PROVIDERS, p.id, health);
      }),
    );
  })());
}

export default { fetch: app.fetch, scheduled };
