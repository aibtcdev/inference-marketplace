/**
 * Provider Directory — the marketplace supply side.
 *
 * A person running their own model registers their endpoint here. We verify it,
 * list it for client agents to discover, and track its health + reputation.
 * Non-custodial: payment flows client → provider directly (x402, payTo = the
 * provider's `payoutAddress`); we are the directory + trust layer.
 *
 * Storage: Cloudflare D1 (SQLite). One row per provider in `providers`, with the
 * shared secret kept in a separate `provider_keys` table (never returned to
 * clients). Row-per-provider avoids the read-modify-write contention of a single
 * JSON blob: concurrent edits to different providers don't collide.
 */

import type { HealthResult } from './health';
import type { ModelSpec } from './schema';
import { normalizeModels } from './schema';

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
  /** Gateway network; when set, payoutAddress must match its prefix. */
  network?: 'mainnet' | 'testnet';
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

/** Reject a payout address whose network doesn't match the gateway's. Both are
 *  valid Stacks addresses, but wallet-signature auth derives the signer address
 *  for the GATEWAY's network — so a mismatched payout could never be matched,
 *  silently locking the owner out. mainnet → SP/SM, testnet → ST/SN. */
export function assertPayoutForNetwork(address: string, network?: 'mainnet' | 'testnet'): void {
  if (!network) return;
  const ok = network === 'mainnet'
    ? address.startsWith('SP') || address.startsWith('SM')
    : address.startsWith('ST') || address.startsWith('SN');
  if (!ok) throw new Error(`payoutAddress must be a ${network} Stacks address (${network === 'mainnet' ? 'SP/SM' : 'ST/SN'})`);
}

type DB = D1Database;

function slugId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 24) || 'provider';
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

/** A providers-table row as stored in D1 (snake_case, JSON columns as text). */
interface ProviderRow {
  id: string;
  name: string;
  endpoint: string;
  api: string;
  payout_address: string;
  description: string | null;
  secured: number;
  status: string;
  flagged: number;
  flag_reason: string | null;
  health: string | null;
  models: string;
  reputation: string | null;
  registered_at: string;
}

function rowToProvider(r: ProviderRow): Provider {
  return {
    id: r.id,
    name: r.name,
    endpoint: r.endpoint,
    api: r.api,
    payoutAddress: r.payout_address,
    models: JSON.parse(r.models) as ModelSpec[],
    ...(r.description ? { description: r.description } : {}),
    secured: !!r.secured,
    health: r.health ? (JSON.parse(r.health) as HealthResult) : null,
    status: r.status as Provider['status'],
    ...(r.flagged ? { flagged: true } : {}),
    ...(r.flag_reason ? { flagReason: r.flag_reason } : {}),
    reputation: r.reputation ? (JSON.parse(r.reputation) as Provider['reputation']) : null,
    registeredAt: r.registered_at,
  };
}

export async function listProviders(db: DB): Promise<Provider[]> {
  const { results } = await db.prepare('SELECT * FROM providers ORDER BY registered_at').all<ProviderRow>();
  return (results ?? []).map(rowToProvider);
}

export async function getProvider(db: DB, id: string): Promise<Provider | undefined> {
  const row = await db.prepare('SELECT * FROM providers WHERE id = ?').bind(id).first<ProviderRow>();
  return row ? rowToProvider(row) : undefined;
}

/** Insert a provider row (+ its key). Shared by register and commitUpdate. */
async function writeProvider(db: DB, p: Provider): Promise<void> {
  await db
    .prepare(
      `INSERT INTO providers (id, name, endpoint, api, payout_address, description, secured, status, flagged, flag_reason, health, models, reputation, registered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, endpoint=excluded.endpoint, api=excluded.api, payout_address=excluded.payout_address,
         description=excluded.description, secured=excluded.secured, status=excluded.status, flagged=excluded.flagged,
         flag_reason=excluded.flag_reason, health=excluded.health, models=excluded.models, reputation=excluded.reputation`,
    )
    .bind(
      p.id, p.name, p.endpoint, p.api, p.payoutAddress, p.description ?? null,
      p.secured ? 1 : 0, p.status, p.flagged ? 1 : 0, p.flagReason ?? null,
      p.health ? JSON.stringify(p.health) : null, JSON.stringify(p.models),
      p.reputation ? JSON.stringify(p.reputation) : null, p.registeredAt,
    )
    .run();
}

/** Validate + persist a new provider (status `pending` until first health check). */
export async function registerProvider(db: DB, input: ProviderInput): Promise<Provider> {
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
  assertPayoutForNetwork(payoutAddress, input.network);
  if (!models.length) throw new Error('at least one model (with an id) is required');

  const dupe = await db.prepare('SELECT id FROM providers WHERE endpoint = ?').bind(endpoint).first();
  if (dupe) throw new Error('this endpoint is already registered');

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

  await writeProvider(db, provider);
  if (input.apiKey) {
    await db.prepare('INSERT OR REPLACE INTO provider_keys (id, shared_key) VALUES (?, ?)').bind(provider.id, input.apiKey).run();
  }
  return provider;
}

/** The shared secret for a provider (server-side only). */
export async function getProviderKey(db: DB, id: string): Promise<string | undefined> {
  const row = await db.prepare('SELECT shared_key FROM provider_keys WHERE id = ?').bind(id).first<{ shared_key: string }>();
  return row?.shared_key ?? undefined;
}

/** Set (or rotate) a provider's shared secret and mark it secured. */
export async function setProviderKey(db: DB, id: string, key: string): Promise<Provider | undefined> {
  const provider = await getProvider(db, id);
  if (!provider) return undefined;
  await db.prepare('INSERT OR REPLACE INTO provider_keys (id, shared_key) VALUES (?, ?)').bind(id, key).run();
  await db.prepare('UPDATE providers SET secured = 1 WHERE id = ?').bind(id).run();
  return { ...provider, secured: true };
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
  /** Gateway network; when set, a changed payoutAddress must match its prefix. */
  network?: 'mainnet' | 'testnet';
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
export async function prepareUpdate(db: DB, id: string, patch: ProviderUpdate): Promise<PreparedUpdate | undefined> {
  const current = await getProvider(db, id);
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
      const dupe = await db.prepare('SELECT id FROM providers WHERE endpoint = ? AND id != ?').bind(endpoint, id).first();
      if (dupe) throw new Error('this endpoint is already registered');
      next.endpoint = endpoint;
      endpointChanged = true;
    }
  }

  if (patch.payoutAddress !== undefined) {
    const payoutAddress = patch.payoutAddress.trim();
    if (!/^S[PMTN][0-9A-Z]+$/.test(payoutAddress)) throw new Error('payoutAddress must be a Stacks address (SP/SM mainnet, ST/SN testnet)');
    assertPayoutForNetwork(payoutAddress, patch.network);
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
  let effectiveKey = await getProviderKey(db, id);
  if (typeof patch.apiKey === 'string' && patch.apiKey.length > 0) {
    effectiveKey = patch.apiKey;
    next.secured = true;
    keyChanged = true;
  }

  return { provider: next, effectiveKey, endpointChanged, keyChanged };
}

/** Persist a prepared update (record + optional rotated shared key). */
export async function commitUpdate(db: DB, provider: Provider, newKey?: string): Promise<Provider> {
  const exists = await db.prepare('SELECT id FROM providers WHERE id = ?').bind(provider.id).first();
  if (!exists) throw new Error('provider not found');
  await writeProvider(db, provider);
  if (newKey) await db.prepare('INSERT OR REPLACE INTO provider_keys (id, shared_key) VALUES (?, ?)').bind(provider.id, newKey).run();
  return provider;
}

/** Update a provider's health snapshot + derived status. */
export async function setHealth(db: DB, id: string, health: HealthResult): Promise<Provider | undefined> {
  const res = await db
    .prepare('UPDATE providers SET health = ?, status = ? WHERE id = ?')
    .bind(JSON.stringify(health), health.status, id)
    .run();
  if (!res.meta.changes) return undefined;
  return getProvider(db, id);
}

/** Flag (or clear) a provider. A flagged provider is de-routed regardless of
 *  health; clearing restores it to normal routing. Enforcement lives here, not
 *  in the inference plane. */
export async function setFlag(db: DB, id: string, flagged: boolean, reason?: string): Promise<Provider | undefined> {
  const res = await db
    .prepare('UPDATE providers SET flagged = ?, flag_reason = ? WHERE id = ?')
    .bind(flagged ? 1 : 0, flagged ? reason ?? null : null, id)
    .run();
  if (!res.meta.changes) return undefined;
  return getProvider(db, id);
}

export async function removeProvider(db: DB, id: string): Promise<boolean> {
  await db.prepare('DELETE FROM provider_keys WHERE id = ?').bind(id).run();
  const res = await db.prepare('DELETE FROM providers WHERE id = ?').bind(id).run();
  return !!res.meta.changes;
}
