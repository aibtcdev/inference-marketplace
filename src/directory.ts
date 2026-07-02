/**
 * Provider Directory — the marketplace supply side.
 *
 * A person running their own model registers their endpoint here. We verify it,
 * list it for client agents to discover, and track its health + reputation.
 * Non-custodial: payment flows client → provider directly (x402, payTo = the
 * provider's `payoutAddress`); we are the directory + trust layer.
 *
 * Storage: Cloudflare KV. Providers live as a single JSON array under the
 * `providers` key (fine for the expected scale; swap to per-key + index later).
 */

import type { HealthResult } from './health';
import type { ModelSpec } from './schema';
import { normalizeModels } from './schema';

const KEY = 'providers';

export interface Provider {
  id: string;
  name: string;
  /** Provider's OpenAI-compatible inference endpoint (ideally x402-gated). */
  endpoint: string;
  /** API contract the endpoint speaks. */
  api: string;
  /** Stacks address that receives payment for this provider's inference. */
  payoutAddress: string;
  /** Structured per-model capability specs the provider declares. */
  models: ModelSpec[];
  description?: string;
  /** Endpoint is protected by a shared key only the gateway holds (no bypass). */
  secured: boolean;
  /** Latest health snapshot (null until first check). */
  health: HealthResult | null;
  /** Marketplace status, derived from health. */
  status: 'pending' | 'live' | 'degraded' | 'down';
  /** Flagged by the marketplace (cheating / abuse). Orthogonal to health: a
   *  flagged provider is de-routed regardless of health, and stays flagged
   *  across health checks until explicitly cleared. */
  flagged?: boolean;
  /** Why it was flagged + when (for the audit trail / UI). */
  flagReason?: string;
  /** ERC-8004 reputation (Phase 3). null until it has feedback. */
  reputation: { agentId: number; score?: number } | null;
  registeredAt: string;
}

export interface ProviderInput {
  name: string;
  endpoint: string;
  payoutAddress: string;
  api?: string;
  models: Array<string | ModelSpec>;
  description?: string;
  /** Shared secret the endpoint requires; stored server-side, never returned. */
  apiKey?: string;
  /** Dev/testnet only: permit http://localhost endpoints. */
  allowLocal?: boolean;
  reputationAgentId?: number;
}

/** Loopback / private / link-local / metadata hosts we must never fetch (SSRF). */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::1') return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  if (/^(fc|fd|fe8|fe9|fea|feb)/.test(h)) return true; // IPv6 ULA / link-local
  return false;
}

/** Guard the URLs the gateway will fetch. Prevents SSRF to internal resources. */
export function assertSafeEndpoint(endpoint: string, allowLocal: boolean): void {
  let u: URL;
  try { u = new URL(endpoint); } catch { throw new Error('endpoint must be a valid URL (e.g. https://host/v1)'); }
  if (allowLocal) {
    if (u.protocol === 'https:') return;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return;
    throw new Error('endpoint must be https (or http://localhost in dev)');
  }
  if (u.protocol !== 'https:') throw new Error('endpoint must be an https URL');
  if (isPrivateHost(u.hostname)) {
    throw new Error('endpoint must be a public host (loopback/private/metadata addresses are not allowed)');
  }
}

/** KV key holding a provider's shared secret (kept out of the provider record). */
const keyKey = (id: string) => `key:${id}`;

type KV = KVNamespace;

function slugId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 24) || 'provider';
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

export async function listProviders(kv: KV): Promise<Provider[]> {
  const raw = await kv.get(KEY);
  return raw ? (JSON.parse(raw) as Provider[]) : [];
}

async function saveAll(kv: KV, providers: Provider[]): Promise<void> {
  await kv.put(KEY, JSON.stringify(providers));
}

export async function getProvider(kv: KV, id: string): Promise<Provider | undefined> {
  return (await listProviders(kv)).find((p) => p.id === id);
}

/** Validate + persist a new provider (status `pending` until first health check). */
export async function registerProvider(kv: KV, input: ProviderInput): Promise<Provider> {
  const name = (input.name || '').trim();
  const endpoint = (input.endpoint || '').trim().replace(/\/$/, '');
  const payoutAddress = (input.payoutAddress || '').trim();
  const models = normalizeModels(input.models);
  const api = (input.api || 'openai-chat').trim();

  if (!name) throw new Error('name is required (set it in schema.json or the form)');
  assertSafeEndpoint(endpoint, input.allowLocal ?? false); // SSRF guard
  // Basic hygiene only: a Stacks address on either network (mainnet SP/SM,
  // testnet ST/SN). Not a security check — the bond gate requires this to be a
  // real bonded principal and settlement verifies the actual on-chain txid.
  if (!/^S[PMTN][0-9A-Z]+$/.test(payoutAddress)) throw new Error('payoutAddress must be a Stacks address (SP/SM mainnet, ST/SN testnet)');
  if (!models.length) throw new Error('at least one model (with an id) is required');

  const providers = await listProviders(kv);
  if (providers.some((p) => p.endpoint === endpoint)) throw new Error('this endpoint is already registered');

  const provider: Provider = {
    id: slugId(name),
    name,
    endpoint,
    api,
    payoutAddress,
    models,
    ...(input.description ? { description: input.description.trim() } : {}),
    secured: Boolean(input.apiKey),
    health: null,
    status: 'pending',
    reputation: input.reputationAgentId ? { agentId: input.reputationAgentId } : null,
    registeredAt: new Date().toISOString(),
  };

  providers.push(provider);
  await saveAll(kv, providers);
  if (input.apiKey) await kv.put(keyKey(provider.id), input.apiKey);
  return provider;
}

/** The shared secret for a provider (server-side only). */
export async function getProviderKey(kv: KV, id: string): Promise<string | undefined> {
  return (await kv.get(keyKey(id))) ?? undefined;
}

/** A partial edit to an existing provider. Only the present fields change. */
export interface ProviderUpdate {
  name?: string;
  endpoint?: string;
  payoutAddress?: string;
  api?: string;
  models?: Array<string | ModelSpec>;
  description?: string;
  /** Rotate the shared secret (stored server-side, never returned). */
  apiKey?: string;
  reputationAgentId?: number;
  allowLocal?: boolean;
}

export interface PreparedUpdate {
  /** The merged record, not yet persisted. */
  provider: Provider;
  /** Key to (re)verify the endpoint with — the new one if rotated, else current. */
  effectiveKey?: string;
  endpointChanged: boolean;
  keyChanged: boolean;
}

/**
 * Validate a partial update and produce the merged record WITHOUT persisting.
 * Only fields present in `patch` change; everything else is preserved from the
 * current record (so this can never be used to inject `flagged`, `status`, `id`,
 * etc.). The caller re-verifies reachability when the endpoint or key changed,
 * then calls `commitUpdate`. Throws on invalid input (same rules as
 * registration). Returns undefined if the provider doesn't exist.
 */
export async function prepareUpdate(kv: KV, id: string, patch: ProviderUpdate): Promise<PreparedUpdate | undefined> {
  const providers = await listProviders(kv);
  const current = providers.find((p) => p.id === id);
  if (!current) return undefined;

  const next: Provider = { ...current, models: [...current.models] };

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error('name cannot be empty');
    next.name = name;
  }

  let endpointChanged = false;
  if (patch.endpoint !== undefined) {
    const endpoint = patch.endpoint.trim().replace(/\/$/, '');
    assertSafeEndpoint(endpoint, patch.allowLocal ?? false); // SSRF guard
    if (endpoint !== current.endpoint) {
      if (providers.some((p) => p.id !== id && p.endpoint === endpoint)) {
        throw new Error('this endpoint is already registered');
      }
      next.endpoint = endpoint;
      endpointChanged = true;
    }
  }

  if (patch.payoutAddress !== undefined) {
    const payoutAddress = patch.payoutAddress.trim();
    if (!/^S[PMTN][0-9A-Z]+$/.test(payoutAddress)) throw new Error('payoutAddress must be a Stacks address (SP/SM mainnet, ST/SN testnet)');
    next.payoutAddress = payoutAddress;
  }

  if (patch.api !== undefined) {
    const api = patch.api.trim();
    if (api) next.api = api;
  }

  if (patch.models !== undefined) {
    const models = normalizeModels(patch.models);
    if (!models.length) throw new Error('at least one model (with an id) is required');
    next.models = models;
  }

  if (patch.description !== undefined) {
    const d = patch.description.trim();
    if (d) next.description = d;
    else delete next.description;
  }

  if (patch.reputationAgentId !== undefined) {
    next.reputation = patch.reputationAgentId
      ? { ...(next.reputation ?? {}), agentId: patch.reputationAgentId }
      : null;
  }

  // Key rotation. We never un-secure an endpoint via update (that would expose
  // it), so an empty/absent apiKey leaves the current key in place.
  let keyChanged = false;
  let effectiveKey = await getProviderKey(kv, id);
  if (typeof patch.apiKey === 'string' && patch.apiKey.length > 0) {
    effectiveKey = patch.apiKey;
    next.secured = true;
    keyChanged = true;
  }

  return { provider: next, effectiveKey, endpointChanged, keyChanged };
}

/** Persist a prepared update (record + optional rotated shared key). */
export async function commitUpdate(kv: KV, provider: Provider, newKey?: string): Promise<Provider> {
  const providers = await listProviders(kv);
  const i = providers.findIndex((p) => p.id === provider.id);
  if (i === -1) throw new Error('provider not found');
  providers[i] = provider;
  await saveAll(kv, providers);
  if (newKey) await kv.put(keyKey(provider.id), newKey);
  return provider;
}

/** Update a provider's health snapshot + derived status. */
export async function setHealth(kv: KV, id: string, health: HealthResult): Promise<Provider | undefined> {
  const providers = await listProviders(kv);
  const p = providers.find((x) => x.id === id);
  if (!p) return undefined;
  p.health = health;
  p.status = health.status;
  await saveAll(kv, providers);
  return p;
}

/** Flag (or clear) a provider. A flagged provider is de-routed regardless of
 *  health; clearing restores it to normal routing. Enforcement lives here, not
 *  in the inference plane. */
export async function setFlag(kv: KV, id: string, flagged: boolean, reason?: string): Promise<Provider | undefined> {
  const providers = await listProviders(kv);
  const p = providers.find((x) => x.id === id);
  if (!p) return undefined;
  if (flagged) {
    p.flagged = true;
    if (reason) p.flagReason = reason;
  } else {
    delete p.flagged;
    delete p.flagReason;
  }
  await saveAll(kv, providers);
  return p;
}

export async function removeProvider(kv: KV, id: string): Promise<boolean> {
  const providers = await listProviders(kv);
  const next = providers.filter((p) => p.id !== id);
  if (next.length === providers.length) return false;
  await saveAll(kv, next);
  await kv.delete(keyKey(id));
  return true;
}
