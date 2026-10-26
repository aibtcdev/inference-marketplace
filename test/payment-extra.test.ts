import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPaymentExtra } from '../src/x402-middleware';

const SPONSOR = 'SP3F6ZPHAR5D0YT0CTPJST7H3NBZ43A5FW226FMYP';

// x402-stacks@2.1.0 interceptor-v2.js L114: the only test the client applies.
const clientSponsors = (extra: Record<string, unknown>) => typeof extra.feePayer === 'string';

test('relay wired + sponsor address: advertises feePayer, so the client signs sponsored', () => {
  const extra = buildPaymentExtra({ pricing: { model: 'x' } }, true, SPONSOR);
  assert.deepEqual(extra, { pricing: { model: 'x' }, sponsored: true, feePayer: SPONSOR });
  assert.equal(clientSponsors(extra), true);
});

test('relay wired, no sponsor address: old shape, which the client signs self-paid (#33)', () => {
  const extra = buildPaymentExtra(undefined, true, undefined);
  assert.deepEqual(extra, { sponsored: true });
  assert.equal(clientSponsors(extra), false);
  assert.deepEqual(buildPaymentExtra(undefined, true, '  '), { sponsored: true });
});

test('no relay binding: never advertises sponsorship, even with an address set', () => {
  assert.deepEqual(buildPaymentExtra(undefined, false, SPONSOR), {});
  assert.deepEqual(buildPaymentExtra({ pricing: 1 }, false, SPONSOR), { pricing: 1 });
});

test('the base extra object is not mutated', () => {
  const base = { pricing: 1 };
  buildPaymentExtra(base, true, SPONSOR);
  assert.deepEqual(base, { pricing: 1 });
});
