/**
 * Legion engagement-stake reads.
 *
 * Staking is OPTIONAL and never required to earn — it only buys ranking. The
 * gateway reads a community provider's stake from `legion-engage` and ranks
 * higher-staked providers first. All reads are best-effort and cached; ranking
 * must never break routing, so failures degrade to "unstaked" (stake 0).
 */
import { principalCV, cvToHex, hexToCV, cvToValue } from '@stacks/transactions';

type KV =
  | {
      get(k: string): Promise<string | null>;
      put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void>;
    }
  | undefined;

function stacksApiBase(env: any): string {
  const net = (env.NETWORK || 'testnet') as 'mainnet' | 'testnet';
  return env.STACKS_API || (net === 'mainnet' ? 'https://api.hiro.so' : 'https://api.testnet.hiro.so');
}

/**
 * A provider's staked sBTC (base units) from `legion-engage`, or 0n if not
 * staked / not configured / unreadable. Never throws. Cached in KV for
 * LEGION_STAKE_CACHE_TTL seconds.
 */
export async function getProviderStake(env: any, principal: string): Promise<bigint> {
  const contract: string | undefined = env.LEGION_ENGAGE; // "ADDR.legion-engage"
  if (!contract) return 0n;
  const dot = contract.indexOf('.');
  if (dot < 1 || dot === contract.length - 1) return 0n;
  const addr = contract.slice(0, dot);
  const name = contract.slice(dot + 1);

  const kv = env.PROVIDERS as KV;
  const ttl = Number(env.LEGION_STAKE_CACHE_TTL ?? '60');
  const cacheKey = `stake:${principal}`;
  if (kv && ttl > 0) {
    try {
      const cached = await kv.get(cacheKey);
      if (cached != null) return BigInt(cached);
    } catch {
      /* cache is best-effort */
    }
  }

  let stake = 0n;
  try {
    const r = await fetch(`${stacksApiBase(env)}/v2/contracts/call-read/${addr}/${name}/get-stake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: addr, arguments: [cvToHex(principalCV(principal))] }),
    });
    if (r.ok) {
      const body: any = await r.json();
      if (body?.okay && typeof body.result === 'string') {
        const v = cvToValue(hexToCV(body.result));
        stake = BigInt(v && typeof v === 'object' && 'value' in v ? v.value : v);
      }
    }
  } catch {
    /* ranking is best-effort; treat as unstaked */
  }

  if (kv && ttl > 0) {
    try {
      await kv.put(cacheKey, stake.toString(), { expirationTtl: ttl });
    } catch {
      /* best-effort */
    }
  }
  return stake;
}

/**
 * Sort providers by on-chain stake (descending). Reads stakes concurrently.
 * Returns a NEW array; ties keep input order (stable). No-op when LEGION_ENGAGE
 * is unset or there's nothing to sort.
 */
export async function rankByStake<T extends { payoutAddress: string }>(env: any, providers: T[]): Promise<T[]> {
  if (!env.LEGION_ENGAGE || providers.length < 2) return providers;
  const stakes = await Promise.all(providers.map((p) => getProviderStake(env, p.payoutAddress)));
  return providers
    .map((p, i) => ({ p, stake: stakes[i], i }))
    .sort((a, b) => (b.stake > a.stake ? 1 : b.stake < a.stake ? -1 : a.i - b.i))
    .map((x) => x.p);
}
