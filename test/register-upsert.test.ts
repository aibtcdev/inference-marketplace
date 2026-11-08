/**
 * Re-registering the same provider (payout + name + models) from a new endpoint
 * moves the existing listing instead of adding a row (#25).
 */
import { describe, it, expect } from 'vitest';
import * as directory from '../src/directory';
import { makeD1 } from './d1';

const PAYOUT = 'SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7';
const input = (endpoint: string, over: Partial<directory.ProviderInput> = {}): directory.ProviderInput => ({
  name: 'agenthub',
  endpoint,
  payoutAddress: PAYOUT,
  models: [{ id: 'Qwen/Qwen2.5-0.5B-Instruct' }],
  pricePerRequest: '5',
  acceptedToken: 'sBTC',
  network: 'mainnet',
  ...over,
} as directory.ProviderInput);

describe('registration upsert', () => {
  it('same payout + name + models from a new endpoint updates the listing in place', async () => {
    const db = makeD1() as never;
    const first = await directory.registerProvider(db, input('https://a1.lhr.life', { apiKey: 'k1' }));
    await directory.setFlag(db, first.id, true, 'audit');
    const prep = await directory.prepareRegistration(db, input('https://a2.lhr.life', { name: 'AgentHub', pricePerRequest: '7' }));
    expect(prep.replaces?.id).toBe(first.id);
    await directory.commitRegistration(db, prep);

    const all = await directory.listProviders(db);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: first.id, endpoint: 'https://a2.lhr.life', pricePerRequest: '7', registeredAt: first.registeredAt, flagged: true, secured: false });
    expect(await directory.getProviderKey(db, first.id)).toBeUndefined(); // new endpoint, no key → old key dropped
  });

  it('different models or a different payout is a new listing', async () => {
    const db = makeD1() as never;
    await directory.registerProvider(db, input('https://a1.example'));
    const other = await directory.prepareRegistration(db, input('https://a2.example', { models: [{ id: 'meta-llama/Llama-3.2-1B-Instruct' }] as never }));
    expect(other.replaces).toBeUndefined();
    const otherPayout = await directory.prepareRegistration(db, input('https://a3.example', { payoutAddress: 'SP1HTBVD3JG9C05J7HBJTHGR0GGW7KXW28M5JS8QE' }));
    expect(otherPayout.replaces).toBeUndefined();
  });

  it('an endpoint already registered is still refused', async () => {
    const db = makeD1() as never;
    await directory.registerProvider(db, input('https://a1.example'));
    await expect(directory.prepareRegistration(db, input('https://a1.example'))).rejects.toThrow('already registered');
  });
});
