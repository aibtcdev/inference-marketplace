// BigInt.toJSON polyfill for JSON.stringify compatibility
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { cors } from 'hono/cors';
import { x402Middleware, x402DynamicMiddleware } from './x402-middleware';
import type { X402Context, TokenType } from './x402-middleware';
import { proxyChatCompletion } from './upstream';
import type { ChatCompletionBody } from './upstream';
import * as directory from './directory';
import { rankByStake } from './legion';
import { legionForModel } from './model-legions';
import { checkEndpoint, verifyProvider } from './health';
import { REGISTRATION_SCHEMA } from './schema';
import { validateHfModel } from './hf';
import { recoverWalletAuth, toNetwork, AUTH_SKEW_SECONDS, type AuthAction } from './wallet-auth';
import { renderSkillMd } from './skill';

type Env = {
  NETWORK: string;
  /** Dev-only ("true"): allow http://localhost provider endpoints (set in .dev.vars,
   *  never in a deployed env). Deployed gateways are always https-only. */
  ALLOW_LOCAL_ENDPOINTS?: string;
  RELAY_URL: string;
  /** Service binding to x402-sponsor-relay's RelayRPC. When set, the 402 advertises
   *  `extra.sponsored` and sponsored txs settle via sponsorPayment (relay pays gas). */
  X402_RELAY?: Fetcher;
  /** D1 database holding the provider directory (providers + provider_keys). */
  DB: D1Database;
  /** KV namespace for ephemeral data: wallet-auth replay nonces + legion stake cache. */
  PROVIDERS: KVNamespace;
  /** DEV-ONLY: 'true' bypasses payment on non-mainnet (see x402-middleware). */
  SKIP_PAYMENT?: string;
  /** Owner address of the per-model legions (e.g. "STGX5YP…"). Each model family
   *  has its own contracts named `legion-{treasury,fees,gov}-<family>` under this
   *  one owner. When set, fee routing + stake ranking resolve per model (a Qwen
   *  call's 8% → legion-treasury-qwen, ranked by legion-gov-qwen). See
   *  src/model-legions.ts. Unset → legacy single-legion via LEGION_FEES/ENGAGE. */
  LEGION_OWNER?: string;
  /** Legion engagement-stake contract ("ADDR.legion-engage"). LEGACY fallback for
   *  models that don't map to a per-model legion: gateway reads each community
   *  provider's stake from it and ranks higher-staked providers first. Optional:
   *  staking is not required to earn, it only buys ranking. */
  LEGION_ENGAGE?: string;
  /** Seconds to cache a provider's read stake. Default 60; 0 disables. */
  LEGION_STAKE_CACHE_TTL?: string;
  /** Shared secret for marketplace enforcement actions (flagging). Sent as the
   *  X-Admin-Token header. On mainnet the flag endpoint is disabled unless this
   *  is set; off mainnet it is open for testing. */
  ADMIN_TOKEN?: string;
};

/** Where a /v1/chat/completions request was resolved to, decided in the pricing
 *  middleware and consumed by the handler after settlement. Every model is
 *  served by a registered (community) provider — the marketplace runs no models
 *  of its own. */
type CompletionRoute = { kind: 'community'; providerId: string; modelId: string };

type Variables = {
  x402?: X402Context;
  route?: CompletionRoute;
  /** Per-model legion (fees/treasury/gov) resolved for fee routing. */
  legion?: import('./model-legions').ModelLegion;
};

/** A fresh shared secret (48 hex chars) — the gateway's upstream-routing credential. */
function genSharedKey(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

type WalletAuthOutcome = null | { ok: true } | { ok: false; status: 401 | 403; error: string };

/**
 * Authorize a request by the provider's payout-wallet signature. Returns `null`
 * when no signature header is present (caller falls back to other auth);
 * otherwise verifies the signature recovers to the provider's `payoutAddress`,
 * is within the timestamp window, and hasn't been replayed.
 * Headers: `X-Stacks-Signature` (RSV hex), `X-Stacks-Public-Key`, `X-Stacks-Timestamp`.
 * `action` scopes the signature so, e.g., an `update` sig can't reveal a key.
 */
async function tryWalletAuth(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  provider: directory.Provider,
  action: AuthAction,
): Promise<WalletAuthOutcome> {
  const signature = c.req.header('X-Stacks-Signature');
  if (!signature) return null;
  const rec = recoverWalletAuth(
    {
      network: toNetwork(c.env.NETWORK),
      action,
      providerId: provider.id,
      timestamp: Number(c.req.header('X-Stacks-Timestamp')),
      signature,
      publicKey: c.req.header('X-Stacks-Public-Key') || '',
    },
    Math.floor(Date.now() / 1000),
  );
  if (!rec.ok) return { ok: false, status: 401, error: rec.error };
  if (rec.address !== provider.payoutAddress) {
    return { ok: false, status: 403, error: "signature does not match this provider's payout wallet" };
  }
  // One-time nonce: reject replays within the window. Key on the canonical r||s
  // (first 64 bytes), NOT the full signature — the recovery byte `v` is malleable
  // (both v=0/v=1 verify), so keying on the whole string would let a flipped-v
  // copy slip past. Verification enforces low-S, so r||s is canonical.
  const nonceKey = `sigused:${signature.replace(/^0x/, '').slice(0, 128)}`;
  if (await c.env.PROVIDERS.get(nonceKey)) return { ok: false, status: 401, error: 'signature already used (replay)' };
  await c.env.PROVIDERS.put(nonceKey, '1', { expirationTtl: AUTH_SKEW_SECONDS * 2 });
  return { ok: true };
}

/**
 * Forward an already-paid chat completion to a registered provider's endpoint,
 * using the shared key only the gateway holds, and attach the marketplace
 * receipt. Shared by the catalog endpoint (community models) and the
 * /v1/route/:id proxy so both behave identically. Payment has already settled
 * directly to the provider (non-custodial) before this runs.
 */
async function routeToProvider(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  provider: directory.Provider,
  body: ChatCompletionBody,
  payment: X402Context | undefined,
): Promise<Response> {
  const key = (await directory.getProviderKey(c.env.DB, provider.id)) ?? '';

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
      model: body.model,
      provider: provider.id,
      paidTo: provider.payoutAddress,
      payment: { txId: payment?.settleResult?.transaction, payer: payment?.payerAddress },
    },
  }, upstream.status as 200);
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// CORS with x402 headers exposed
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['payment-signature', 'X-PAYMENT-TOKEN-TYPE', 'Authorization', 'Content-Type', 'X-Stacks-Signature', 'X-Stacks-Public-Key', 'X-Stacks-Timestamp', 'X-Admin-Token'],
  exposeHeaders: ['payment-required', 'payment-response', 'X-PAYER-ADDRESS'],
}));

// Every paid route settles directly to a registered provider (non-custodial),
// so the gateway holds no serving secrets. Discovery routes (info, health,
// catalog, providers) are always available.

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
    fees: {
      providerShare: '100%',
      marketplaceFee: '0%',
      custody: 'non-custodial — the client pays the provider on-chain directly, in the provider\'s chosen token (sBTC/USDCx), to its payout wallet; the gateway never holds funds',
      toEarn: 'free — no listing fee, no bond required to register or earn',
    },
    endpoints: {
      skill: 'GET /skill.md  (agent skill manifest — read this first)',
      models: 'GET /v1/models',
      providers: 'GET /v1/providers',
      chatCompletions: 'POST /v1/chat/completions  (OpenAI-compatible; flat per-request price set by the provider)',
      routeToProvider: 'POST /v1/route/{id}/chat/completions  (call a specific provider; settles to them)',
      registerProvider: 'POST /v1/providers',
      updateProvider: 'PATCH /v1/providers/{id}  (self-service; Authorization: Bearer <shared key>)',
      flagProvider: 'POST /v1/providers/{id}/flag  (operator only, admin token)',
      feedback: 'POST /v1/feedback  (Phase 3, reputation)',
    },
    trust: {
      enforcedBy: 'operator',
      model: 'A provider can be flagged (de-routed everywhere, removed from catalog) by the marketplace operator via an admin-token-gated endpoint. This is a manual action; there is no automatic cheat-detection yet. Agents/users can report a provider, but only the operator can flag.',
      flaggedStatusPublic: "GET /v1/providers exposes each provider's `flagged` and `flagReason`",
      roadmap: 'flag decision moving on-chain to a stake-weighted legion-gov vote',
    },
  });
});

app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString(), network: c.env.NETWORK || 'testnet' });
});

// Agent skill manifest (markdown). A single document an agent can fetch and act
// on in one step — pay-per-inference + provider onboarding — generated from the
// live catalog so it never drifts.
app.get('/skill.md', async (c) => {
  const providers = await directory.listProviders(c.env.DB);
  const md = renderSkillMd({
    origin: new URL(c.req.url).origin,
    network: c.env.NETWORK || 'testnet',
    providers,
  });
  c.header('Content-Type', 'text/markdown; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=60');
  return c.body(md);
});

// Model catalog. Each entry carries the provider's flat per-request price, in
// the provider's own token — exactly the amount the 402 will ask for.
app.get('/v1/models', async (c) => {
  // Every model is served by a live registered provider. Callable via
  // /v1/chat/completions (model id) or the explicit /v1/route/:id proxy; payment
  // settles to the provider directly, in the provider's chosen token. Exclude
  // flagged, down and unpriced providers, then rank by stake so higher-staked
  // providers list first (staking buys ranking; it is never required to earn).
  const liveProviders = (await directory.listProviders(c.env.DB)).filter((p) => p.status !== 'down' && !p.flagged && p.pricePerRequest);
  const providers = await rankByStake(c.env, liveProviders);
  const community = [];
  for (const p of providers) {
    for (const m of p.models) {
      community.push({
        id: m.id,
        name: m.name ?? m.id,
        contextLength: m.contextLength ?? null,
        capabilities: m.capabilities ?? [],
        providerId: p.id,
        source: 'community',
        status: p.status,
        acceptedToken: p.acceptedToken,
        route: `/v1/route/${p.id}/chat/completions`,
        pricePerRequest: { amount: p.pricePerRequest, token: p.acceptedToken },
      });
    }
  }

  return c.json({ object: 'list', data: community });
});

// Provider directory (supply side) — external providers registered via the UI.
app.get('/v1/providers', async (c) => {
  const data = await directory.listProviders(c.env.DB);
  return c.json({ object: 'list', data });
});

// ---------------------------------------------------------------------------
// Inference (paid via x402)
// ---------------------------------------------------------------------------

/**
 * OpenAI-compatible chat completions. The serving provider is resolved from the
 * requested `model`; the client pays that provider's flat per-request price, in
 * the provider's chosen token, directly to them before we forward the request.
 */
app.post('/v1/chat/completions',
  x402DynamicMiddleware(async (c, _tokenType: TokenType) => {
    let body: ChatCompletionBody;
    try {
      body = await c.req.json<ChatCompletionBody>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    // Every model is served by a registered provider. The client pays the
    // provider directly (non-custodial) at the provider's per-request price, in
    // the token the provider chose. Exclude flagged and unpriced providers, then
    // pick the highest-staked one for the model (staking buys ranking; never required).
    const providers = await directory.listProviders(c.env.DB);
    const candidates = providers.filter(
      (p) => p.status === 'live' && !p.flagged && p.pricePerRequest && p.models.some((m) => m.id === body.model),
    );
    const provider = (await rankByStake(c.env, candidates))[0];
    const model = provider?.models.find((m) => m.id === body.model);
    if (!provider || !model) {
      return c.json({
        error: `Unknown model: ${body.model ?? '(none)'}`,
        hint: 'GET /v1/models for the catalog',
      }, 400);
    }
    c.set('route', { kind: 'community', providerId: provider.id, modelId: model.id });
    // route this model's 8% skim to its model legion
    c.set('legion', legionForModel(c.env, model.id) ?? undefined);
    // The provider set a flat price in the token it's paid in — advertise only
    // that, so the client pays the provider directly exactly what they asked.
    return {
      amount: provider.pricePerRequest!,
      tokenType: provider.acceptedToken,
      payTo: provider.payoutAddress,
      extra: { pricing: { type: 'per-request', model: model.id, provider: provider.id } },
    };
  }),
  async (c) => {
    const payment = c.get('x402');
    const body = await c.req.json<ChatCompletionBody>();
    const route = c.get('route');
    if (route?.kind !== 'community') {
      return c.json({ error: `No live provider for model ${body.model}` }, 503);
    }

    // Forward to the provider's endpoint (payment already settled to them).
    const provider = await directory.getProvider(c.env.DB, route.providerId);
    if (!provider || provider.status === 'down' || provider.flagged) {
      return c.json({ error: `No live provider for model ${body.model}` }, 503);
    }
    return routeToProvider(c, provider, body, payment);
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

  // --- Ownership: require a payout-wallet signature. No signature → don't store.
  // The signer, recovered from the signature, MUST equal the payoutAddress being
  // registered — that match proves the registrant owns the payout wallet (and, since
  // the address is derived for THIS gateway's network, enforces the network too: a
  // mainnet wallet recovers to a different address and is rejected). Scoped to the
  // endpoint URL so a signature can't be replayed to register a different endpoint.
  const claimedPayout = typeof body.payoutAddress === 'string' ? body.payoutAddress.trim() : '';
  const signedEndpoint = typeof body.endpoint === 'string' ? body.endpoint
    : typeof body.manifestUrl === 'string' ? body.manifestUrl : '';
  if (!claimedPayout) return c.json({ error: 'payoutAddress is required' }, 400);
  const regSig = c.req.header('X-Stacks-Signature');
  if (!regSig) {
    return c.json({ error: 'sign with your payout wallet (X-Stacks-Signature) to register — endpoints are only stored after ownership is proven' }, 401);
  }
  const regAuth = recoverWalletAuth(
    {
      network: toNetwork(c.env.NETWORK),
      action: 'register',
      providerId: signedEndpoint,
      timestamp: Number(c.req.header('X-Stacks-Timestamp')),
      signature: regSig,
      publicKey: c.req.header('X-Stacks-Public-Key') || '',
    },
    Math.floor(Date.now() / 1000),
  );
  if (!regAuth.ok) return c.json({ error: regAuth.error }, 401);
  if (regAuth.address !== claimedPayout) {
    return c.json(
      { error: `signature signed as ${regAuth.address}, which doesn't match payoutAddress ${claimedPayout} — switch your wallet to ${toNetwork(c.env.NETWORK)} and reconnect` },
      403,
    );
  }
  const regNonceKey = `sigused:${regSig.replace(/^0x/, '').slice(0, 128)}`;
  if (await c.env.PROVIDERS.get(regNonceKey)) return c.json({ error: 'signature already used (replay)' }, 401);
  await c.env.PROVIDERS.put(regNonceKey, '1', { expirationTtl: AUTH_SKEW_SECONDS * 2 });

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
        // A price sent alongside the manifest (e.g. from the register form) wins,
        // together with its token, since the price is denominated in that token.
        const bodyPrice = body.pricePerRequest !== undefined
          ? { pricePerRequest: body.pricePerRequest, acceptedToken: body.acceptedToken }
          : {};
        reg = { ...manifest, endpoint: (manifest.endpoint as string) || (body.endpoint as string), ...bodyPrice } as unknown as directory.ProviderInput;
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
  reg.allowLocal = c.env.ALLOW_LOCAL_ENDPOINTS === 'true'; // dev-only; deployed = https-only
  reg.network = toNetwork(c.env.NETWORK); // payoutAddress must match this network
  reg.payoutAddress = claimedPayout; // the signature-verified owner wins over any manifest value
  let provider;
  try {
    provider = await directory.registerProvider(c.env.DB, reg);
  } catch (e) {
    if (e instanceof directory.DuplicateProviderError) {
      return c.json({ error: e.message, existingId: e.existingId, update: `PATCH /v1/providers/${e.existingId}` }, 409);
    }
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }

  // Gate: verify reachable AND functional before confirming (using the shared
  // key if the endpoint is secured). Roll back if not.
  const v = await verifyProvider(provider.endpoint, reg.apiKey);
  if (!v.ok) {
    await directory.removeProvider(c.env.DB, provider.id);
    return c.json({ error: v.error, reachable: v.reachable, functional: v.functional }, 400);
  }
  const updated = await directory.setHealth(c.env.DB, provider.id, v.health);
  return c.json(
    { provider: updated ?? provider, verification: { reachable: true, functional: true, servedModel: v.servedModel, sample: v.sample } },
    201,
  );
});

// Re-run the health check for one provider on demand.
app.post('/v1/providers/:id/check', async (c) => {
  const id = c.req.param('id');
  const provider = await directory.getProvider(c.env.DB, id);
  if (!provider) return c.json({ error: 'Provider not found' }, 404);
  // Probe WITH the provider's key (like the cron) — a secured provider's proxy
  // 401s a keyless probe, which would record a false "down" and overwrite the
  // real status.
  const key = provider.secured ? await directory.getProviderKey(c.env.DB, id) : undefined;
  const health = await checkEndpoint(provider.endpoint, key);
  const updated = await directory.setHealth(c.env.DB, id, health);
  return c.json({ provider: updated });
});

// Update a provider in place (self-service). Authorized ONLY by a payout-wallet
// signature: the provider signs a short message with the Stacks wallet that is
// their `payoutAddress` (works from web / curl / MCP). Headers: X-Stacks-Signature,
// X-Stacks-Public-Key, X-Stacks-Timestamp; a timestamp + one-time nonce prevent
// replay. The shared key is the gateway's upstream-routing credential, not an
// ownership token, so it is NOT accepted here.
// Editable: name, models, payoutAddress, description, api, endpoint, and the
// shared key itself (rotation). Only fields present in the body change; unknown
// fields (status/flagged/id/…) are ignored. Changing the endpoint or key
// re-verifies reachability + function BEFORE the change is saved, so a bad edit
// can never take a live provider offline.
//
// Signed message: "Inference Marketplace\nAction: update\nProvider: <id>\nTimestamp: <unix>"
//   curl -X PATCH $GATEWAY/v1/providers/$ID \
//     -H 'X-Stacks-Signature: <sig>' -H 'X-Stacks-Public-Key: <pub>' -H 'X-Stacks-Timestamp: <ts>' \
//     -H 'Content-Type: application/json' -d '{"models":[{"id":"Qwen/Qwen2.5-7B-Instruct"}]}'
app.patch('/v1/providers/:id', async (c) => {
  const id = c.req.param('id');
  const provider = await directory.getProvider(c.env.DB, id);
  if (!provider) return c.json({ error: 'Provider not found' }, 404);

  const rawBody = await c.req.text();

  // --- Authenticate: payout-wallet signature only. Ownership is proven by a
  // signature that recovers to the provider's payoutAddress — the same single
  // proof used at registration. (The shared key is the gateway's upstream routing
  // credential, not an ownership token, so it is NOT accepted here.) ------------
  const wallet = await tryWalletAuth(c, provider, 'update');
  if (!wallet) return c.json({ error: 'sign with your payout wallet (X-Stacks-Signature) to edit this endpoint' }, 401);
  if (!wallet.ok) return c.json({ error: wallet.error }, wallet.status);

  let body: Record<string, unknown>;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Re-validate any model ids against Hugging Face (same gate as registration).
  if (body.models !== undefined) {
    const patchModels = Array.isArray(body.models) ? (body.models as Array<string | { id?: string }>) : [];
    const modelIds = patchModels.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean) as string[];
    if (modelIds.length === 0) return c.json({ error: 'at least one model id is required' }, 400);
    const hfChecks = await Promise.all(modelIds.map((mid) => validateHfModel(mid)));
    const badModel = hfChecks.find((r) => !r.valid);
    if (badModel) return c.json({ error: badModel.error }, 400);
  }

  // prepareUpdate only reads known fields, so extra body keys can't be injected.
  const patch = body as directory.ProviderUpdate;
  patch.allowLocal = c.env.ALLOW_LOCAL_ENDPOINTS === 'true'; // dev-only; deployed = https-only
  patch.network = toNetwork(c.env.NETWORK);

  let prepared;
  try {
    prepared = await directory.prepareUpdate(c.env.DB, id, patch);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  if (!prepared) return c.json({ error: 'Provider not found' }, 404);

  // Re-verify only when the endpoint or key changed (models/name/payout edits
  // don't touch reachability). Nothing is persisted unless it passes.
  let verification: Record<string, unknown> | undefined;
  if (prepared.endpointChanged || prepared.keyChanged) {
    const v = await verifyProvider(prepared.provider.endpoint, prepared.effectiveKey);
    if (!v.ok) {
      return c.json({ error: v.error, reachable: v.reachable, functional: v.functional }, 400);
    }
    prepared.provider.health = v.health;
    prepared.provider.status = v.health.status;
    verification = { reachable: true, functional: true, servedModel: v.servedModel, sample: v.sample };
  }

  const updated = await directory.commitUpdate(
    c.env.DB,
    prepared.provider,
    prepared.keyChanged ? prepared.effectiveKey : undefined,
  );
  return c.json({ provider: updated, ...(verification ? { verification } : {}) }, 200);
});

// Reveal (or rotate) a provider's shared key. Wallet-signature gated — only the
// payout-wallet owner can read it back — so this is how a provider recovers a key
// they never saw or lost (the gateway otherwise stores it write-only). Body:
//   {}                → reveal the current key
//   { "rotate": true } → generate a new key, store it, and return it
// Operators may override with ADMIN_TOKEN.
app.post('/v1/providers/:id/key', async (c) => {
  const id = c.req.param('id');
  const provider = await directory.getProvider(c.env.DB, id);
  if (!provider) return c.json({ error: 'Provider not found' }, 404);

  const rawBody = await c.req.text();
  const admin = c.env.ADMIN_TOKEN;
  const isAdmin = Boolean(admin) && c.req.header('X-Admin-Token') === admin;
  if (!isAdmin) {
    const wallet = await tryWalletAuth(c, provider, 'reveal-key');
    if (!wallet) return c.json({ error: 'sign with your payout wallet (X-Stacks-Signature) to reveal your key' }, 401);
    if (!wallet.ok) return c.json({ error: wallet.error }, wallet.status);
  }

  let rotate = false;
  try {
    rotate = rawBody ? Boolean((JSON.parse(rawBody) as { rotate?: unknown }).rotate) : false;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (rotate) {
    const key = genSharedKey();
    await directory.setProviderKey(c.env.DB, id, key);
    return c.json({ key, secured: true, rotated: true });
  }
  const key = await directory.getProviderKey(c.env.DB, id);
  if (!key) {
    return c.json({ secured: false, key: null, message: 'this provider has no shared key (open endpoint); send {"rotate":true} to set one' });
  }
  return c.json({ key, secured: true, rotated: false });
});

// Remove a provider (operator/self-service).
// Remove a provider from the directory (destructive: drops it everywhere and
// deletes its stored key). Gated by ADMIN_TOKEN (X-Admin-Token header) — same
// enforcement lever as /flag. Provider ids are public, so an ungated delete
// would let anyone knock any provider (or the whole marketplace) offline.
// Providers who just want to go offline stop their tunnel (health de-routes them);
// removal from the directory is an operator action.
app.delete('/v1/providers/:id', async (c) => {
  const admin = c.env.ADMIN_TOKEN;
  if (!admin) return c.json({ error: 'delete endpoint requires ADMIN_TOKEN to be configured' }, 503);
  if (c.req.header('X-Admin-Token') !== admin) return c.json({ error: 'unauthorized' }, 401);
  const ok = await directory.removeProvider(c.env.DB, c.req.param('id'));
  return c.json({ removed: ok }, ok ? 200 : 404);
});

// Flag / unflag a provider (marketplace enforcement). A flagged provider is
// de-routed everywhere regardless of health, until cleared. Body:
//   { "flagged": true|false, "reason": "..." }   (flagged defaults to true)
// Gated by ADMIN_TOKEN (X-Admin-Token header) when set; disabled on mainnet
// unless ADMIN_TOKEN is configured. This is the enforcement lever; it lives in
// the gateway, not the inference plane.
app.post('/v1/providers/:id/flag', async (c) => {
  const admin = c.env.ADMIN_TOKEN;
  const network = c.env.NETWORK || 'testnet';
  if (admin) {
    if (c.req.header('X-Admin-Token') !== admin) return c.json({ error: 'unauthorized' }, 401);
  } else if (network === 'mainnet') {
    return c.json({ error: 'flag endpoint requires ADMIN_TOKEN on mainnet' }, 503);
  }
  const body = await c.req.json<{ flagged?: boolean; reason?: string }>().catch(() => ({} as { flagged?: boolean; reason?: string }));
  const flagged = body.flagged !== false; // default true
  const updated = await directory.setFlag(c.env.DB, c.req.param('id'), flagged, body.reason);
  if (!updated) return c.json({ error: 'Provider not found' }, 404);
  return c.json({ provider: updated, flagged });
});


// Test console: proxy a chat completion to a provider's endpoint so anyone can
// try it from the UI (server-side call avoids browser CORS). Auto-discovers the
// provider's served model name. If the provider is x402-gated it returns 402.
app.post('/v1/providers/:id/test', async (c) => {
  const provider = await directory.getProvider(c.env.DB, c.req.param('id'));
  if (!provider) return c.json({ error: 'Provider not found' }, 404);

  let body: { prompt?: string; model?: string; max_tokens?: number } = {};
  try { body = await c.req.json(); } catch { /* defaults */ }
  const prompt = body.prompt?.trim() || 'In one sentence, what is Bitcoin?';

  const key = (await directory.getProviderKey(c.env.DB, provider.id)) ?? '';
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
app.post('/v1/route/:id/chat/completions',
  x402DynamicMiddleware(async (c, tokenType: TokenType) => {
    const provider = await directory.getProvider(c.env.DB, c.req.param('id') ?? '');
    if (!provider) return c.json({ error: 'Provider not found' }, 404);
    if (provider.status === 'down') return c.json({ error: 'Provider is currently down' }, 503);

    let body: ChatCompletionBody;
    try { body = await c.req.json<ChatCompletionBody>(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }

    const model = provider.models.find((m) => m.id === body.model) || provider.models[0];
    if (!model) return c.json({ error: 'Provider serves no models' }, 400);
    if (!provider.pricePerRequest) return c.json({ error: 'Provider has not set a price yet' }, 503);

    // The provider's flat per-request price, paid directly to them in the token
    // they chose (sBTC/USDCx); the marketplace takes no custody.
    return {
      amount: provider.pricePerRequest,
      tokenType: provider.acceptedToken,
      payTo: provider.payoutAddress,
      extra: { pricing: { type: 'per-request', model: model.id, provider: provider.id } },
    };
  }),
  async (c) => {
    const provider = await directory.getProvider(c.env.DB, c.req.param('id'));
    if (!provider) return c.json({ error: 'Provider not found' }, 404);
    const body = await c.req.json<ChatCompletionBody>();
    return routeToProvider(c, provider, body, c.get('x402'));
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
    const providers = await directory.listProviders(env.DB);
    await Promise.all(
      providers.map(async (p) => {
        const key = p.secured ? await directory.getProviderKey(env.DB, p.id) : undefined;
        const health = await checkEndpoint(p.endpoint, key);
        await directory.setHealth(env.DB, p.id, health);
      }),
    );
  })());
}

export default { fetch: app.fetch, scheduled };
