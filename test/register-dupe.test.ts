// Test for the #25 fix: same payout wallet + same name = 409-style DuplicateProviderError, not a new row.
// Runs against the REAL src/directory.ts with node:sqlite standing in for D1 (schema.sql applied as-is).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as directory from '../src/directory';

const REPO = process.env.REPO!;
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(`${REPO}/schema.sql`, 'utf8'));
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
  return { prepare: prep } as any;
}
const A = 'SP2SF7ZNAF0SPZ8JTRHMZMZEWDYZ7V9MWK1KS4PB2', B = 'SP7KSYVD0FMKJQKFWXMHPVTG9EN8J21QDJFY4PXN';
const reg = (name: string, url: string, payout = A) =>
  ({ name, endpoint: url, payoutAddress: payout, models: ['Qwen/Qwen2.5-0.5B-Instruct'], network: 'mainnet' as const });

test('re-registering the same wallet+name under a new tunnel URL is refused with the existing id', async () => {
  const db = fakeD1();
  const first = await directory.registerProvider(db, reg('Agenthub Inference', 'https://aaa.lhr.life/v1'));
  await assert.rejects(
    directory.registerProvider(db, reg('agenthub inference ', 'https://bbb.lhr.life/v1')),
    (e: any) => e instanceof directory.DuplicateProviderError && e.existingId === first.id && e.message.includes(`PATCH /v1/providers/${first.id}`),
  );
  assert.equal((await directory.listProviders(db)).length, 1);
});

test('different wallet, or different name, still registers; exact endpoint duplicate keeps its old error', async () => {
  const db = fakeD1();
  await directory.registerProvider(db, reg('Agenthub Inference', 'https://aaa.lhr.life/v1'));
  await directory.registerProvider(db, reg('Agenthub Inference', 'https://ccc.lhr.life/v1', B));
  await directory.registerProvider(db, reg('Other Name', 'https://ddd.lhr.life/v1'));
  assert.equal((await directory.listProviders(db)).length, 3);
  await assert.rejects(directory.registerProvider(db, reg('Third', 'https://aaa.lhr.life/v1')), /already registered/);
});
