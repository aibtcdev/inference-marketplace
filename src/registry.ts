/**
 * Provider Registry
 *
 * The supply side of the marketplace. A provider serves inference and gets
 * paid in sBTC / USDCx. Over time it accrues on-chain reputation from agent
 * feedback (ERC-8004 reputation registry) which the router uses to rank
 * providers that serve the same model.
 *
 * Phase 1 — only the "house" provider is live (OpenRouter via our API key).
 * Phase 2 — `registerProvider` accepts external providers that expose their
 *           own x402-paid inference endpoint; the gateway forwards to them and
 *           splits/settles payment to their Stacks address.
 * Phase 3 — `rankProvidersFor(modelId)` orders competing providers by a blend
 *           of price and `reputationAgentId` score read from the registry.
 */

export type ProviderKind = 'house' | 'external';

export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  /** Stacks address that receives settlement for this provider's inference. */
  payoutAddress: string;
  /**
   * For external providers: base URL of their x402-paid inference endpoint.
   * For the house provider: undefined (we call OpenRouter directly).
   */
  endpoint?: string;
  /**
   * ERC-8004 reputation registry agent id. Reputation is read on-chain via
   * `reputation_get_summary(agentId)`. null until the provider is registered
   * as an agent and has received its first feedback (Phase 3).
   */
  reputationAgentId: number | null;
  /** Marketplace status. */
  status: 'live' | 'pending' | 'suspended';
  registeredAt: string;
}

/**
 * In-memory registry seed. The house provider is always present. External
 * providers registered at runtime would be persisted (KV / D1 / Durable
 * Object) — kept in-memory here so Phase 1 ships with zero infra.
 */
const PROVIDERS: Provider[] = [
  {
    id: 'house',
    name: 'AIBTC House (OpenRouter)',
    kind: 'house',
    // Settlement recipient is configured per-deployment via RECIPIENT_ADDRESS;
    // this field is informational for the catalog. Resolved at request time.
    payoutAddress: 'env:RECIPIENT_ADDRESS',
    reputationAgentId: null, // house is the bootstrap; reputation starts at Phase 2
    status: 'live',
    registeredAt: '2026-06-19T00:00:00.000Z',
  },
];

const PROVIDERS_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: string): Provider | undefined {
  return PROVIDERS_BY_ID.get(id);
}

export function listProviders(): Provider[] {
  return [...PROVIDERS];
}

/**
 * Phase 2 entrypoint. Validates and adds an external provider. Returns the
 * created record. Persistence + on-chain identity registration are wired here
 * when the supply side opens.
 */
export function registerProvider(input: {
  id: string;
  name: string;
  payoutAddress: string;
  endpoint: string;
  reputationAgentId?: number;
}): Provider {
  if (PROVIDERS_BY_ID.has(input.id)) {
    throw new Error(`Provider id already registered: ${input.id}`);
  }
  if (!/^S[PT][A-Z0-9]+$/.test(input.payoutAddress)) {
    throw new Error('Invalid Stacks payout address');
  }
  const provider: Provider = {
    id: input.id,
    name: input.name,
    kind: 'external',
    payoutAddress: input.payoutAddress,
    endpoint: input.endpoint,
    reputationAgentId: input.reputationAgentId ?? null,
    status: 'pending', // becomes 'live' after a health + first-settlement check
    registeredAt: new Date().toISOString(),
  };
  PROVIDERS.push(provider);
  PROVIDERS_BY_ID.set(provider.id, provider);
  return provider;
}
