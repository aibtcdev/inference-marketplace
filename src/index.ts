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
import { listProviders, getProvider, registerProvider } from './registry';
import { quotePrice, realizedCostUsd } from './pricing';
import type { Quote } from './pricing';

type Env = {
  RECIPIENT_ADDRESS: string;
  NETWORK: string;
  RELAY_URL: string;
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

// Provider registry (supply side). House payout resolves to this deployment's
// configured recipient. Reputation is read on-chain in Phase 3.
app.get('/v1/providers', (c) => {
  const providers = listProviders().map((p) => ({
    ...p,
    payoutAddress: p.payoutAddress === 'env:RECIPIENT_ADDRESS'
      ? (c.env.RECIPIENT_ADDRESS || 'unset')
      : p.payoutAddress,
    reputation: p.reputationAgentId === null
      ? { status: 'bootstrapping', summary: null }
      : { status: 'live', agentId: p.reputationAgentId, source: 'erc-8004 reputation_get_summary' },
  }));
  return c.json({ object: 'list', data: providers });
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

// Register an external compute provider (Phase 2). In-memory for now; pending
// until a health + first-settlement check promotes it to 'live'.
app.post('/v1/providers', async (c) => {
  let input: { id?: string; name?: string; payoutAddress?: string; endpoint?: string; reputationAgentId?: number };
  try {
    input = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (!input.id || !input.name || !input.payoutAddress || !input.endpoint) {
    return c.json({ error: 'Required: id, name, payoutAddress, endpoint' }, 400);
  }
  try {
    const provider = registerProvider({
      id: input.id,
      name: input.name,
      payoutAddress: input.payoutAddress,
      endpoint: input.endpoint,
      reputationAgentId: input.reputationAgentId,
    });
    return c.json({ registered: provider, note: 'Status pending until health + settlement check (Phase 2).' }, 201);
  } catch (e) {
    return c.json({ error: String(e instanceof Error ? e.message : e) }, 400);
  }
});

// Submit reputation feedback for a provider (Phase 3). On-chain via the
// ERC-8004 reputation registry. Documented here as the integration point.
app.post('/v1/feedback', async (c) => {
  return c.json({
    error: 'Reputation feedback not enabled yet (Phase 3)',
    howItWorks: 'Agents score a provider after inference; scores are written to the ERC-8004 reputation registry and read back via reputation_get_summary(agentId) to rank competing providers.',
    contract: 'reputation_give_feedback(agentId, rating, ...)',
  }, 501);
});

export default app;
