/**
 * Down providers age out (#28): down_since records the first failure of an
 * outage, /v1/providers hides rows down >24h unless ?include=stale, and the cron
 * deletes rows down >7 days with their shared key.
 */
import { describe, it, expect } from 'vitest';
import app from '../src/index';
import * as directory from '../src/directory';
import { makeD1 } from './d1';

const H = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-01T00:00:00Z');
const health = (status: 'live' | 'down') => ({ status, checkedAt: new Date(T0).toISOString() }) as never;

function insert(db: ReturnType<typeof makeD1>, id: string, downSince: string | null = null) {
  db.raw.prepare(
    `INSERT INTO providers (id, name, endpoint, payout_address, status, models, registered_at, down_since)
     VALUES (?, ?, ?, 'SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7', ?, '[]', '2026-10-01T00:00:00Z', ?)`,
  ).run(id, id, `https://${id}.example/v1`, downSince ? 'down' : 'live', downSince);
  db.raw.prepare('INSERT INTO provider_keys (id, shared_key) VALUES (?, ?)').run(id, 'k');
}

const downSince = async (db: ReturnType<typeof makeD1>, id: string) =>
  (await directory.getProvider(db as never, id))?.downSince;

describe('down_since', () => {
  it('keeps the first failure across repeated down checks', async () => {
    const db = makeD1();
    insert(db, 'p');
    await directory.setHealth(db as never, 'p', health('down'), new Date(T0));
    await directory.setHealth(db as never, 'p', health('down'), new Date(T0 + H));
    await directory.setHealth(db as never, 'p', health('down'), new Date(T0 + 2 * H));
    expect(await downSince(db, 'p')).toBe(new Date(T0).toISOString());
  });

  it('is cleared by one good check', async () => {
    const db = makeD1();
    insert(db, 'p');
    await directory.setHealth(db as never, 'p', health('down'), new Date(T0));
    await directory.setHealth(db as never, 'p', health('live'), new Date(T0 + H));
    expect(await downSince(db, 'p')).toBeUndefined();
  });
});

describe('GET /v1/providers', () => {
  const list = async (db: ReturnType<typeof makeD1>, q = '') => {
    const res = await app.fetch(new Request(`http://gw/v1/providers${q}`), { DB: db, NETWORK: 'mainnet' } as never, {} as never);
    return ((await res.json()) as { data: { id: string }[] }).data.map((p) => p.id);
  };

  it('hides rows down >24h by default, shows them with ?include=stale', async () => {
    const db = makeD1();
    insert(db, 'up');
    insert(db, 'recent', new Date(Date.now() - 2 * H).toISOString());
    insert(db, 'stale', new Date(Date.now() - 25 * H).toISOString());
    expect(await list(db)).toEqual(['up', 'recent']);
    expect(await list(db, '?include=stale')).toEqual(['up', 'recent', 'stale']);
  });
});

describe('expireDownProviders', () => {
  it('deletes rows down >7 days and their key, keeps the rest', async () => {
    const db = makeD1();
    const now = T0 + 30 * 24 * H;
    insert(db, 'old', new Date(now - 8 * 24 * H).toISOString());
    insert(db, 'young', new Date(now - 6 * 24 * H).toISOString());
    insert(db, 'up');
    expect(await directory.expireDownProviders(db as never, now)).toEqual(['old']);
    expect(await directory.getProvider(db as never, 'old')).toBeUndefined();
    expect(db.raw.prepare("SELECT count(*) AS n FROM provider_keys WHERE id = 'old'").get()).toEqual({ n: 0 });
    expect((await directory.listProviders(db as never)).map((p) => p.id)).toEqual(['young', 'up']);
  });
});
