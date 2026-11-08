/**
 * GET /v1/models lists what /v1/chat/completions will route, one entry per
 * model id (#31).
 */
import { describe, it, expect } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1';

let seq = 0;
function insert(db: ReturnType<typeof makeD1>, id: string, models: string[], over: Record<string, unknown> = {}) {
  const row = {
    id, name: id, endpoint: `https://${id}.example/v1`, api: 'openai-chat',
    payout_address: 'SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7', accepted_token: 'sBTC',
    price_per_request: '5', status: 'live', flagged: 0,
    models: JSON.stringify(models.map((m) => ({ id: m }))), registered_at: new Date(Date.UTC(2026, 10, 1) + seq++ * 1000).toISOString(),
    ...over,
  };
  const cols = Object.keys(row);
  db.raw.prepare(`INSERT INTO providers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...(Object.values(row) as never[]));
}

async function models(db: ReturnType<typeof makeD1>) {
  const res = await app.fetch(new Request('http://gw/v1/models'), { DB: db, NETWORK: 'mainnet' } as never, {} as never);
  return ((await res.json()) as { data: any[] }).data;
}

describe('GET /v1/models', () => {
  it('lists only routable providers (not degraded, pending, down, flagged or unpriced)', async () => {
    const db = makeD1();
    insert(db, 'live', ['a/live']);
    insert(db, 'deg', ['a/degraded'], { status: 'degraded' });
    insert(db, 'pend', ['a/pending'], { status: 'pending' });
    insert(db, 'down', ['a/down'], { status: 'down' });
    insert(db, 'flag', ['a/flagged'], { flagged: 1 });
    insert(db, 'free', ['a/unpriced'], { price_per_request: null });
    expect((await models(db)).map((m) => m.id)).toEqual(['a/live']);
  });

  it('one entry per model id, with every provider nested in rank order', async () => {
    const db = makeD1();
    insert(db, 'p1', ['shared/m', 'only/p1']);
    insert(db, 'p2', ['shared/m'], { price_per_request: '7' });
    const data = await models(db);
    expect(data.map((m) => m.id)).toEqual(['shared/m', 'only/p1']);
    const shared = data[0];
    expect(shared.providerId).toBe('p1');
    expect(shared.route).toBe('/v1/route/p1/chat/completions');
    expect(shared.providers.map((p: any) => [p.providerId, p.pricePerRequest.amount])).toEqual([['p1', '5'], ['p2', '7']]);
  });
});
