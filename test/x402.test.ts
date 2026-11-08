/**
 * x402 payment path: pairs each 402 the gateway issues with the tx a real
 * x402-stacks client signs for it, then exercises settlement guards separately.
 * The client is the real interceptor (axios adapter → Hono app); only network
 * edges (Hiro, relay /status, relay settle) are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import axios, { AxiosError, type AxiosAdapter } from 'axios';
import { randomPrivateKey } from '@stacks/transactions';

const verifierSettle = vi.fn();
vi.mock('x402-stacks', async (orig) => ({
  ...(await orig<typeof import('x402-stacks')>()),
  X402PaymentVerifier: class { settle = verifierSettle; },
}));

const { wrapAxiosWithPayment, privateKeyToAccount } = await import('x402-stacks');
const { x402Middleware, decodePaymentTx, resetSponsorStatus, issueRetryCredit, RETRY_CREDIT_MAX_ATTEMPTS, markPaymentUsed, PAYMENT_MARKS_SINCE } = await import('../src/x402-middleware');
const { makeD1 } = await import('./d1');
const { proxyChatCompletion } = await import('../src/upstream');

const PAY_TO = 'ST2VN1G6EBXPMMAJKCSY1HR50YQCVFSK68KKP9SKW';
const FEE_PAYER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const SELF_FEE = 499;

/** Mutable network state the stubbed fetch answers from. */
const net = { canSponsor: true, lastMempoolNonce: null as number | null, lastExecutedNonce: 6, hiroUp: true, noEstimate: false, usedTx: null as any };

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/status/sponsor')) return Response.json({ canSponsor: net.canSponsor });
    if (!net.hiroUp) return new Response('down', { status: 503 });
    if (url.includes('/nonces')) {
      return Response.json({ possible_next_nonce: 7, last_mempool_tx_nonce: net.lastMempoolNonce, last_executed_tx_nonce: net.lastExecutedNonce });
    }
    if (url.includes('/extended/v1/tx?from_address=')) {
      return Response.json({ results: net.usedTx ? [net.usedTx] : [] });
    }
    if (url.includes('/v2/fees/transaction')) {
      if (net.noEstimate) return Response.json({ error: 'Estimation could not be performed', reason: 'NoEstimateAvailable' }, { status: 400 });
      return Response.json({ estimations: [{ fee: 300 }, { fee: SELF_FEE }, { fee: 600 }] });
    }
    if (url.includes('/v2/fees/transfer')) return Response.json(1);
    throw new Error(`unexpected fetch ${url}`);
  }));
}

function makeApp() {
  const app = new Hono();
  app.post('/paid', x402Middleware({ amount: '1', tokenType: 'sBTC', payTo: PAY_TO }), (c) =>
    c.json({ ok: true, txid: (c.get as any)('x402')?.settleResult?.transaction }));
  return app;
}

const relay = { sponsorPayment: vi.fn() };
let db = makeD1();
const env = {
  NETWORK: 'testnet',
  RELAY_URL: 'https://relay.test',
  STACKS_API: 'https://hiro.test',
  X402_SPONSOR_FEE_PAYER: FEE_PAYER,
  X402_RELAY: relay,
  get DB() { return db; },
};

/** Every request the client sends, with the response the gateway gave it. */
type Exchange = { headers: Record<string, string>; status: number; body: any };

function client(app: Hono, log: Exchange[]) {
  const adapter: AxiosAdapter = async (config) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(config.headers ?? {})) if (v != null) headers[k.toLowerCase()] = String(v);
    const res = await app.request(`http://gw${config.url}`, { method: config.method?.toUpperCase(), headers, body: config.data }, env);
    const body = await res.json();
    const resHeaders = Object.fromEntries(res.headers.entries());
    log.push({ headers, status: res.status, body });
    const response = { data: body, status: res.status, statusText: '', headers: resHeaders, config, request: {} };
    if (res.status >= 400) throw new AxiosError(`HTTP ${res.status}`, undefined, config, {}, response as any);
    return response as any;
  };
  const account = privateKeyToAccount(randomPrivateKey(), 'testnet');
  return wrapAxiosWithPayment(axios.create({ adapter }), account);
}

function signedTx(ex: Exchange) {
  const payload = JSON.parse(atob(ex.headers['payment-signature']));
  return decodePaymentTx(payload.payload.transaction, 'testnet')!;
}

beforeEach(() => {
  Object.assign(net, { canSponsor: true, lastMempoolNonce: null, lastExecutedNonce: 6, hiroUp: true, noEstimate: false, usedTx: null });
  db = makeD1();
  resetSponsorStatus();
  relay.sponsorPayment.mockReset().mockResolvedValue({ success: true, txid: 'sponsored-tx', payer: 'payer', fee: '0' });
  verifierSettle.mockReset().mockResolvedValue({ success: true, transaction: 'self-tx', network: 'stacks:2147483648', payer: 'payer' });
  stubFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe('402 → signed tx', () => {
  it('feePayer advertised → client signs sponsored with origin fee 0', async () => {
    const log: Exchange[] = [];
    const res = await client(makeApp(), log).post('/paid', {});
    expect(log[0].status).toBe(402);
    expect(log[0].body.accepts[0].extra).toMatchObject({ feePayer: FEE_PAYER, sponsored: true });
    expect(log[0].body.accepts[0].extra.estimatedFeeUstx).toBeUndefined();
    const tx = signedTx(log[1]);
    expect(tx.sponsored).toBe(true);
    expect(tx.fee).toBe(0n);
    expect(relay.sponsorPayment).toHaveBeenCalledOnce();
    expect(verifierSettle).not.toHaveBeenCalled();
    expect(res.data.txid).toBe('sponsored-tx');
  });

  it('no feePayer → client signs self-paid and the 402 carries the fee estimate', async () => {
    net.canSponsor = false;
    const log: Exchange[] = [];
    const res = await client(makeApp(), log).post('/paid', {});
    const extra = log[0].body.accepts[0].extra;
    expect(extra.feePayer).toBeUndefined();
    expect(extra.estimatedFeeUstx).toBe(String(SELF_FEE));
    const tx = signedTx(log[1]);
    expect(tx.sponsored).toBe(false);
    expect(tx.fee).toBeGreaterThan(0n);
    expect(verifierSettle).toHaveBeenCalledOnce();
    expect(res.data.txid).toBe('self-tx');
  });


  it('no fee estimate from Hiro (testnet) → falls back to transfer rate × tx length, like stacks.js', async () => {
    net.canSponsor = false;
    net.noEstimate = true;
    // Own API base so the 60s estimate memo from earlier tests doesn't answer.
    const res = await makeApp().request('http://gw/paid', { method: 'POST' }, { ...env, STACKS_API: 'https://hiro-noest.test' });
    expect((await res.json()).accepts[0].extra.estimatedFeeUstx).toBe('350');
  });
});

describe('self-paid settlement guard', () => {
  beforeEach(() => { net.canSponsor = false; });

  it('refuses while the payer has a pending mempool tx', async () => {
    net.lastMempoolNonce = 6;
    const log: Exchange[] = [];
    await expect(client(makeApp(), log).post('/paid', {})).rejects.toThrow();
    expect(log[1].status).toBe(409);
    expect(log[1].body).toMatchObject({ reason: 'PAYER_TX_PENDING', retryable: true });
    expect(verifierSettle).not.toHaveBeenCalled();
  });

  it('allows a re-sign at the pending nonce (it replaces that tx, so only one can mine)', async () => {
    net.lastMempoolNonce = 7; // the client builder signs at possible_next_nonce = 7
    const log: Exchange[] = [];
    const res = await client(makeApp(), log).post('/paid', {});
    expect(signedTx(log[1]).nonce).toBe(7n);
    expect(verifierSettle).toHaveBeenCalledOnce();
    expect(res.data.txid).toBe('self-tx');
  });

  it('fails closed when the Stacks API cannot be read', async () => {
    const log: Exchange[] = [];
    const api = client(makeApp(), log);
    // Let the client sign (it needs Hiro for nonce/fee), then take Hiro down for settle.
    api.interceptors.request.use((cfg) => {
      if ((cfg.headers as any)?.['payment-signature']) net.hiroUp = false;
      return cfg;
    });
    await expect(api.post('/paid', {})).rejects.toThrow();
    expect(log[1].status).toBe(503);
    expect(log[1].body).toMatchObject({ reason: 'PAYER_NONCE_UNAVAILABLE', retryable: true });
    expect(verifierSettle).not.toHaveBeenCalled();
  });
});

describe('used-nonce reconciliation (#43)', () => {
  const SBTC = 'ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT.sbtc-token';
  // The client signs at possible_next_nonce = 7; nonce 7 already confirmed.
  const minedTx = (payer: string, over: Record<string, unknown> = {}) => ({
    tx_id: '0xabc', sender_address: payer, nonce: 7, tx_status: 'success', canonical: true,
    block_time: Math.floor(Date.now() / 1000) - 30, tx_type: 'contract_call',
    contract_call: {
      contract_id: SBTC, function_name: 'transfer',
      function_args: [{ name: 'amount', repr: 'u1' }, { name: 'sender', repr: `'${payer}` }, { name: 'recipient', repr: `'${PAY_TO}` }],
    },
    ...over,
  });
  // Pin the clock after the D1 marks deploy (PAYMENT_MARKS_SINCE).
  const NOW = (PAYMENT_MARKS_SINCE + 30 * 24 * 3600) * 1000;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    net.canSponsor = false;
    net.lastExecutedNonce = 7;
  });
  afterEach(() => vi.useRealTimers());

  /** Runs one paid request; the mined tx is built from the signing payer. */
  function payer(over: Record<string, unknown> = {}) {
    const log: Exchange[] = [];
    const api = client(makeApp(), log);
    api.interceptors.request.use((cfg) => {
      const sig = (cfg.headers as any)?.['payment-signature'];
      if (sig) net.usedTx = minedTx(decodePaymentTx(JSON.parse(atob(sig)).payload.transaction, 'testnet')!.origin, over);
      return cfg;
    });
    return () => api.post('/paid', {}).catch((e: AxiosError) => e.response!);
  }
  async function pay(over: Record<string, unknown> = {}) {
    return { res: await payer(over)() };
  }

  it('accepts the confirmed payment that used the nonce, once', async () => {
    const first = await pay();
    expect(first.res.status).toBe(200);
    expect(first.res.data.txid).toBe('0xabc');
    expect(verifierSettle).not.toHaveBeenCalled();
    const again = await pay();
    expect(again.res.status).toBe(402);
    expect(again.res.data).toMatchObject({ reason: 'PAYER_NONCE_USED', detail: 'already credited to another request' });
  });

  it('never credits a tx this gateway already settled', async () => {
    net.lastExecutedNonce = 6;
    verifierSettle.mockResolvedValue({ success: true, transaction: '0xABC', network: 'stacks:2147483648', payer: 'payer' });
    expect((await pay()).res.status).toBe(200); // normal settle marks the txid
    net.lastExecutedNonce = 7;
    const claim = await pay();
    expect(claim.res.status).toBe(402);
    expect(claim.res.data.detail).toBe('already credited to another request');
  });

  it('accepts a payment mined days ago (inside the window)', async () => {
    const { res } = await pay({ block_time: NOW / 1000 - 3 * 24 * 3600 });
    expect(res.status).toBe(200);
  });

  it('two concurrent claims of one payment: exactly one is served', async () => {
    const post = payer();
    const results = await Promise.all([post(), post()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 402]);
  });

  it('markPaymentUsed claims a txid once, case- and 0x-insensitively', async () => {
    const d = makeD1();
    expect(await Promise.all([markPaymentUsed(d, '0xABC'), markPaymentUsed(d, 'abc')])).toEqual([true, false]);
  });

  it.each([
    ['failed tx', { tx_status: 'abort_by_response' }, 'tx_status=abort_by_response'],
    ['underpaid', { contract_call: { contract_id: SBTC, function_name: 'transfer', function_args: [{ name: 'amount', repr: 'u0' }, { repr: "'x" }, { name: 'recipient', repr: `'${PAY_TO}` }] } }, 'underpaid'],
    ['wrong recipient', { contract_call: { contract_id: SBTC, function_name: 'transfer', function_args: [{ name: 'amount', repr: 'u1' }, { repr: "'x" }, { name: 'recipient', repr: "'ST000000000000000000002AMW42H" }] } }, 'wrong recipient'],
    ['wrong token', { contract_call: { contract_id: 'ST1.other', function_name: 'transfer', function_args: [] } }, 'wrong token'],
    ['tx older than 7 days', { block_time: NOW / 1000 - 8 * 24 * 3600 }, 'older than the reconcile window'],
    ['tx mined before marks were durable', { block_time: PAYMENT_MARKS_SINCE - 60 }, 'older than the reconcile window'],
  ])('refuses a %s', async (_l, over, detail) => {
    const { res } = await pay(over);
    expect(res.status).toBe(402);
    expect(res.data).toMatchObject({ reason: 'PAYER_NONCE_USED', detail });
    expect(verifierSettle).not.toHaveBeenCalled();
  });
});

describe('sponsored settle failure', () => {
  it('hands back self-paid requirements when the relay can no longer sponsor', async () => {
    relay.sponsorPayment.mockImplementation(async () => {
      net.canSponsor = false; // relay went down between 402 and settle
      return { success: false, code: 'SPONSOR_EXHAUSTED', error: 'no funds', retryable: true };
    });
    const log: Exchange[] = [];
    await expect(client(makeApp(), log).post('/paid', {})).rejects.toThrow();
    expect(log[1].status).toBe(503);
    expect(log[1].body.retrySelfPaid).toBe(true);
    expect(log[1].body.nonce).toBe(signedTx(log[1]).nonce.toString());
    expect(log[1].body.accepts[0].extra.feePayer).toBeUndefined();
    expect(log[1].body.accepts[0].extra.estimatedFeeUstx).toBe(String(SELF_FEE));
  });

  it('pins the nonce when the relay call throws (broadcast state unknown)', async () => {
    relay.sponsorPayment.mockImplementation(async () => {
      net.canSponsor = false;
      throw new Error('rpc timeout');
    });
    const log: Exchange[] = [];
    await expect(client(makeApp(), log).post('/paid', {})).rejects.toThrow();
    expect(log[1].status).toBe(502);
    expect(log[1].body.retrySelfPaid).toBe(true);
    expect(log[1].body.nonce).toBe(signedTx(log[1]).nonce.toString());
  });

  it('omits the nonce when the relay says that nonce cannot mine', async () => {
    relay.sponsorPayment.mockImplementation(async () => {
      net.canSponsor = false;
      return { success: false, code: 'SENDER_NONCE_STALE', error: 'nonce already used', retryable: false };
    });
    const log: Exchange[] = [];
    await expect(client(makeApp(), log).post('/paid', {})).rejects.toThrow();
    expect(log[1].status).toBe(402);
    expect(log[1].body.retrySelfPaid).toBe(true);
    expect(log[1].body.nonce).toBeUndefined();
  });

  it('no self-pay hint while the relay still reports canSponsor', async () => {
    relay.sponsorPayment.mockResolvedValue({ success: false, code: 'BROADCAST_FAILED', error: 'x', retryable: true });
    const log: Exchange[] = [];
    await expect(client(makeApp(), log).post('/paid', {})).rejects.toThrow();
    expect(log[1].body.retrySelfPaid).toBeUndefined();
    expect(log[1].body.nonce).toBeUndefined();
  });
});

describe('upstream after settlement', () => {
  it('a network error becomes a 502 instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('connection refused'); }));
    const r = await proxyChatCompletion('https://p.test/v1', '', { model: 'm', messages: [] });
    expect(r.status).toBe(502);
  });

  it('a hung provider becomes a 504', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_, rej) => {
      init.signal!.addEventListener('abort', () => rej(init.signal!.reason));
    })));
    const r = await proxyChatCompletion('https://p.test/v1', '', { model: 'm', messages: [] }, 20);
    expect(r.status).toBe(504);
  });
});

describe('retry credit after a paid upstream failure', () => {
  function memKV() {
    const m = new Map<string, string>();
    return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); } };
  }
  const retryReq = (app: Hono, token: string, e: object) =>
    app.request('http://gw/paid', { method: 'POST', headers: { 'X-PAYMENT-RETRY-TOKEN': token } }, e);

  it('a token re-serves the request once, for the provider that was paid, without settling', async () => {
    const kv = memKV();
    const token = (await issueRetryCredit(kv, { txid: 'paid-tx', payTo: PAY_TO, payer: 'SPPAYER' }))!;
    const app = makeApp();
    const e = { ...env, PROVIDERS: kv };

    const ok = await retryReq(app, token, e);
    expect(ok.status).toBe(200);
    expect((await ok.json()).txid).toBe('paid-tx');
    expect(relay.sponsorPayment).not.toHaveBeenCalled();
    expect(verifierSettle).not.toHaveBeenCalled();

    const again = await retryReq(app, token, e);
    expect(again.status).toBe(402);
    expect((await again.json()).code).toBe('RETRY_TOKEN_INVALID');
  });

  it('refuses a token paid to another provider and keeps it usable', async () => {
    const kv = memKV();
    const token = (await issueRetryCredit(kv, { txid: 'paid-tx', payTo: 'ST-OTHER', payer: 'SPPAYER' }))!;
    const res = await retryReq(makeApp(), token, { ...env, PROVIDERS: kv });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: 'RETRY_TOKEN_WRONG_PROVIDER', paidTo: 'ST-OTHER' });
    expect(kv.m.has(`retry:${token}`)).toBe(true);
  });

  it('stops issuing tokens after the retry cap, and never for the dev bypass', async () => {
    const kv = memKV();
    expect(await issueRetryCredit(kv, { txid: 'paid-tx', payTo: PAY_TO, attempts: RETRY_CREDIT_MAX_ATTEMPTS })).toBeNull();
    expect(await issueRetryCredit(kv, { txid: 'dev-skip', payTo: PAY_TO })).toBeNull();
    expect(kv.m.size).toBe(0);
  });
});
