/**
 * Legion engagement-stake reads.
 *
 * Staking is OPTIONAL and never required to earn — it only buys ranking. The
 * gateway reads a community provider's stake from `legion-engage` and ranks
 * higher-staked providers first. All reads are best-effort and cached; ranking
 * must never break routing, so failures degrade to "unstaked" (stake 0).
 */
import { principalCV, cvToHex, hexToCV, cvToValue } from '@stacks/transactions';
import { legionForModel } from './model-legions';

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
export async function getProviderStake(env: any, principal: string, govContract?: string): Promise<bigint> {
  // Per-model gov is the ranking signal (also the legacy single `legion-engage`
  // env as a fallback). gov + engage both expose `get-stake(principal) -> uint`.
  const contract: string | undefined = govContract || env.LEGION_ENGAGE;
  if (!contract) return 0n;
  const dot = contract.indexOf('.');
  if (dot < 1 || dot === contract.length - 1) return 0n;
  const addr = contract.slice(0, dot);
  const name = contract.slice(dot + 1);

  const kv = env.PROVIDERS as KV;
  const ttl = Number(env.LEGION_STAKE_CACHE_TTL ?? '60');
  // key by contract too, so different model legions never collide in the cache.
  const cacheKey = `stake:${name}:${principal}`;
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
 * Sort providers by on-chain stake (descending). Each provider's stake is read
 * from the gov of the model it serves (its first declared model resolves the
 * legion), so a Qwen provider ranks by its Qwen-legion stake. Falls back to the
 * legacy single `legion-engage` env for models that don't map to a legion.
 * Returns a NEW array; ties keep input order (stable). No-op when nothing maps
 * and there's no legacy engage configured.
 */
export async function rankByStake<T extends { payoutAddress: string; models?: { id: string }[] }>(
  env: any,
  providers: T[],
): Promise<T[]> {
  if (providers.length < 2) return providers;
  const govFor = (p: T) => legionForModel(env, p.models?.[0]?.id)?.gov ?? env.LEGION_ENGAGE;
  if (!providers.some(govFor)) return providers; // nothing to rank by
  const stakes = await Promise.all(
    providers.map((p) => {
      const gov = govFor(p);
      return gov ? getProviderStake(env, p.payoutAddress, gov) : Promise.resolve(0n);
    }),
  );
  return providers
    .map((p, i) => ({ p, stake: stakes[i], i }))
    .sort((a, b) => (b.stake > a.stake ? 1 : b.stake < a.stake ? -1 : a.i - b.i))
    .map((x) => x.p);
}
