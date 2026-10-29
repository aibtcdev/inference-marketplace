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
const { x402Middleware, decodePaymentTx, resetSponsorStatus } = await import('../src/x402-middleware');
const { proxyChatCompletion } = await import('../src/upstream');

const PAY_TO = 'ST2VN1G6EBXPMMAJKCSY1HR50YQCVFSK68KKP9SKW';
const FEE_PAYER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const SELF_FEE = 499;

/** Mutable network state the stubbed fetch answers from. */
const net = { canSponsor: true, lastMempoolNonce: null as number | null, hiroUp: true };

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/status/sponsor')) return Response.json({ canSponsor: net.canSponsor });
    if (!net.hiroUp) return new Response('down', { status: 503 });
    if (url.includes('/nonces')) {
      return Response.json({ possible_next_nonce: 7, last_mempool_tx_nonce: net.lastMempoolNonce, last_executed_tx_nonce: 6 });
    }
    if (url.includes('/v2/fees/transaction')) {
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
const env = {
  NETWORK: 'testnet',
  RELAY_URL: 'https://relay.test',
  STACKS_API: 'https://hiro.test',
  X402_SPONSOR_FEE_PAYER: FEE_PAYER,
  X402_RELAY: relay,
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
  Object.assign(net, { canSponsor: true, lastMempoolNonce: null, hiroUp: true });
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
    expect(log[1].body.accepts[0].extra.feePayer).toBeUndefined();
    expect(log[1].body.accepts[0].extra.estimatedFeeUstx).toBe(String(SELF_FEE));
  });

  it('no self-pay hint while the relay still reports canSponsor', async () => {
    relay.sponsorPayment.mockResolvedValue({ success: false, code: 'BROADCAST_FAILED', error: 'x', retryable: true });
    const log: Exchange[] = [];
    await expect(client(makeApp(), log).post('/paid', {})).rejects.toThrow();
    expect(log[1].body.retrySelfPaid).toBeUndefined();
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
