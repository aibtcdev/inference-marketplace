// The /v1/models catalog and the routing predicate it shares with /v1/chat/completions (#31).
import type { Provider } from './directory';

/** A provider the gateway will route a paid request to: live, not flagged, and priced.
 *  /v1/models and /v1/chat/completions both use this, so the catalog never lists a
 *  model the router can't serve (degraded and pending providers are left out of both). */
export function isRoutable(p: Provider): boolean {
  return p.status === 'live' && !p.flagged && !!p.pricePerRequest;
}

/** One catalog entry per model id. `ranked` is the routable providers in stake order
 *  (rankByStake); each entry nests the providers serving that model in the same order.
 *  The top-level providerId / route / pricePerRequest are the first provider, the one
 *  /v1/chat/completions picks for `model: id`. */
export function buildModelCatalog(ranked: Provider[]) {
  const byId = new Map<string, any>();
  for (const p of ranked) {
    for (const m of p.models) {
      const provider = {
        providerId: p.id,
        status: p.status,
        acceptedToken: p.acceptedToken,
        route: `/v1/route/${p.id}/chat/completions`,
        pricePerRequest: { amount: p.pricePerRequest, token: p.acceptedToken },
      };
      const entry = byId.get(m.id);
      if (entry) {
        entry.providers.push(provider);
        continue;
      }
      byId.set(m.id, {
        id: m.id,
        name: m.name ?? m.id,
        contextLength: m.contextLength ?? null,
        capabilities: m.capabilities ?? [],
        source: 'community',
        ...provider,
        providers: [provider],
      });
    }
  }
  return [...byId.values()];
}
