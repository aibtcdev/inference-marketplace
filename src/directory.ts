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
  reputationAgentId?: number;
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

  const isHttps = /^https:\/\/.+/.test(endpoint);
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/.test(endpoint);
  if (!name) throw new Error('name is required (set it in schema.json or the form)');
  if (!isHttps && !isLocal) throw new Error('endpoint must be an https URL (e.g. https://host/v1)');
  if (!/^S[PM][0-9A-Z]+$/.test(payoutAddress)) throw new Error('payoutAddress must be a mainnet Stacks address (SP… / SM…)');
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

export async function removeProvider(kv: KV, id: string): Promise<boolean> {
  const providers = await listProviders(kv);
  const next = providers.filter((p) => p.id !== id);
  if (next.length === providers.length) return false;
  await saveAll(kv, next);
  await kv.delete(keyKey(id));
  return true;
}
