// Tests for #31: /v1/models lists only what the router serves, one entry per model id.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildModelCatalog, isRoutable } from '../src/catalog';
import type { Provider } from '../src/directory';

const QWEN = 'Qwen/Qwen2.5-0.5B-Instruct';
const LLAMA = 'meta-llama/Llama-3.2-1B-Instruct';
function provider(id: string, status: Provider['status'], models: string[], extra: Partial<Provider> = {}): Provider {
  return {
    id, name: id, endpoint: `https://${id}.example/v1`, api: 'openai', payoutAddress: 'SP2SF7ZNAF0SPZ8JTRHMZMZEWDYZ7V9MWK1KS4PB2',
    acceptedToken: 'sBTC', pricePerRequest: '5', models: models.map((m) => ({ id: m })), secured: true, health: null, status, ...extra,
  } as Provider;
}

// The router's candidate filter in /v1/chat/completions.
const routerServes = (all: Provider[], model: string) => all.filter((p) => isRoutable(p) && p.models.some((m) => m.id === model));

test('degraded, pending, down, flagged and unpriced providers are not routable; live priced ones are', () => {
  assert.equal(isRoutable(provider('a', 'live', [QWEN])), true);
  for (const s of ['degraded', 'pending', 'down'] as const) assert.equal(isRoutable(provider('a', s, [QWEN])), false, s);
  assert.equal(isRoutable(provider('a', 'live', [QWEN], { flagged: true })), false);
  assert.equal(isRoutable(provider('a', 'live', [QWEN], { pricePerRequest: null })), false);
});

test('a model served only by degraded providers is not listed (catalog matches the router)', () => {
  const all = [provider('live1', 'live', [QWEN]), provider('deg1', 'degraded', [LLAMA]), provider('deg2', 'degraded', [LLAMA, QWEN])];
  const data = buildModelCatalog(all.filter(isRoutable));
  assert.deepEqual(data.map((e) => e.id), [QWEN]);
  for (const e of data) assert.ok(routerServes(all, e.id).length > 0, `${e.id} listed but unroutable`);
  assert.deepEqual(data[0].providers.map((p: any) => p.providerId), ['live1']);
});

test('one entry per model id, providers nested in stake order, top level = the provider chat/completions picks', () => {
  // `ranked` is already in rankByStake order: p1 > p2 > p3.
  const ranked = [provider('p1', 'live', [QWEN, LLAMA]), provider('p2', 'live', [QWEN]), provider('p3', 'live', [LLAMA, QWEN], { acceptedToken: 'USDCx' as any, pricePerRequest: '900' })];
  const data = buildModelCatalog(ranked);
  const ids = data.map((e) => e.id);
  assert.deepEqual(ids, [QWEN, LLAMA]);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
  const qwen = data.find((e) => e.id === QWEN);
  assert.deepEqual(qwen.providers.map((p: any) => p.providerId), ['p1', 'p2', 'p3']);
  assert.equal(qwen.providerId, 'p1');
  assert.equal(qwen.route, '/v1/route/p1/chat/completions');
  assert.deepEqual(qwen.pricePerRequest, { amount: '5', token: 'sBTC' });
  assert.deepEqual(qwen.providers[2].pricePerRequest, { amount: '900', token: 'USDCx' });
  const llama = data.find((e) => e.id === LLAMA);
  assert.deepEqual(llama.providers.map((p: any) => p.providerId), ['p1', 'p3']);
});

test('the issue shape: 6 providers x 2 models gives 2 entries, not 12', () => {
  const ranked = Array.from({ length: 6 }, (_, i) => provider(`p${i}`, 'live', [QWEN, LLAMA]));
  const data = buildModelCatalog(ranked);
  assert.equal(data.length, 2);
  assert.ok(data.every((e) => e.providers.length === 6));
});
