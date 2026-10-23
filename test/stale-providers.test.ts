// Tests for #28: down_since bookkeeping, hiding long-down rows, and expiring them.
// Runs against the REAL src/directory.ts with node:sqlite standing in for D1 (schema.sql applied as-is).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as directory from '../src/directory';
import type { HealthResult } from '../src/health';

const SCHEMA = new URL('../schema.sql', import.meta.url);
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(SCHEMA, 'utf8'));
  const prep = (sql: string) => {
    let args: unknown[] = [];
    const st = db.prepare(sql);
    const o: any = {
      bind: (...a: unknown[]) => { args = a; return o; },
      first: async () => (st.get(...(args as any)) as any) ?? null,
      all: async () => ({ results: st.all(...(args as any)) }),
      run: async () => { const r = st.run(...(args as any)); return { meta: { changes: Number(r.changes) } }; },
    };
    return o;
  };
  return { db, d1: { prepare: prep } as any };
}
const A = 'SP2SF7ZNAF0SPZ8JTRHMZMZEWDYZ7V9MWK1KS4PB2';
const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-10-23T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const health = (status: HealthResult['status'], checkedAt: string): HealthResult =>
  ({ status, latencyMs: 0, httpCode: status === 'down' ? 0 : 200, x402: false, checkedAt });
async function register(d1: any, url = 'https://aaa.lhr.life/v1') {
  return directory.registerProvider(d1, {
    name: `P ${url}`, endpoint: url, payoutAddress: A, models: ['Qwen/Qwen2.5-0.5B-Instruct'], network: 'mainnet', pricePerRequest: 5,
  } as any);
}

test('down → down → down keeps the time of the first failure', async () => {
  const { d1 } = fakeD1();
  const p = await register(d1);
  await directory.setHealth(d1, p.id, health('down', ago(10 * 60_000)));
  await directory.setHealth(d1, p.id, health('down', ago(5 * 60_000)));
  const after = await directory.setHealth(d1, p.id, health('down', ago(0)));
  assert.equal(after?.downSince, ago(10 * 60_000));
});

test('down → live clears down_since (degraded counts as up too)', async () => {
  const { d1 } = fakeD1();
  const p = await register(d1);
  await directory.setHealth(d1, p.id, health('down', ago(HOUR)));
  assert.equal((await directory.setHealth(d1, p.id, health('live', ago(0))))?.downSince, undefined);
  await directory.setHealth(d1, p.id, health('down', ago(HOUR)));
  assert.equal((await directory.setHealth(d1, p.id, health('degraded', ago(0))))?.downSince, undefined);
});

test('down_since 25 h ago is stale (hidden by default, kept with ?include=stale); 23 h is not', async () => {
  const { d1 } = fakeD1();
  const old = await register(d1, 'https://old.lhr.life/v1');
  const recent = await register(d1, 'https://new.lhr.life/v1');
  await directory.setHealth(d1, old.id, health('down', ago(25 * HOUR)));
  await directory.setHealth(d1, recent.id, health('down', ago(23 * HOUR)));
  const all = await directory.listProviders(d1);
  assert.equal(all.length, 2); // ?include=stale path: nothing deleted
  assert.deepEqual(all.filter((p) => !directory.isStale(p, NOW)).map((p) => p.id), [recent.id]);
});

test('down_since 8 days ago is deleted by the cron with its provider_keys row; 6 days is kept', async () => {
  const { db, d1 } = fakeD1();
  const dead = await register(d1, 'https://dead.lhr.life/v1');
  const grace = await register(d1, 'https://grace.lhr.life/v1');
  db.prepare('INSERT INTO provider_keys (id, shared_key) VALUES (?, ?)').run(dead.id, 'k');
  await directory.setHealth(d1, dead.id, health('down', ago(8 * 24 * HOUR)));
  await directory.setHealth(d1, grace.id, health('down', ago(6 * 24 * HOUR)));
  assert.deepEqual(await directory.expireDeadProviders(d1, NOW), [dead.id]);
  assert.deepEqual((await directory.listProviders(d1)).map((p) => p.id), [grace.id]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM provider_keys WHERE id = ?').get(dead.id)!.n, 0);
});
