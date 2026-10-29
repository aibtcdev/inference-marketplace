/**
 * x402 Payment Middleware — x402 v2 (Coinbase-compatible) via the official
 * `x402-stacks` library and the AIBTC settlement relay (facilitator).
 *
 * Flow:
 *   1. No `payment-signature` header → 402 with PaymentRequiredV2
 *      (base64 in the `payment-required` header + JSON body, `accepts[]`).
 *   2. `payment-signature` present → decode PaymentPayloadV2, settle via the
 *      relay, attach payment context, continue.
 *
 * Pricing is computed by us (catalog cost × markup → token base units); this
 * module only handles the x402 envelope + settlement.
 */

import type { Context, Next, MiddlewareHandler } from 'hono';
import {
  X402PaymentVerifier,
  networkToCAIP2,
  X402_HEADERS,
  X402_ERROR_CODES,
} from 'x402-stacks';
import type {
  PaymentRequiredV2,
  PaymentRequirementsV2,
  PaymentPayloadV2,
  SettlementResponseV2,
} from 'x402-stacks';
import {
  deserializeTransaction,
  AuthType,
  addressHashModeToVersion,
  addressFromVersionHash,
  addressToString,
  createContractCallPayload,
  createTokenTransferPayload,
  serializePayload,
  uintCV,
  standardPrincipalCV,
  someCV,
  bufferCV,
} from '@stacks/transactions';

export type TokenType = 'STX' | 'sBTC' | 'USDCx';

export interface TokenContract {
  address: string;
  name: string;
}

export interface X402Config {
  amount: string;
  tokenType: TokenType;
  /** Recipient override — pay a specific provider directly (non-custodial). */
  payTo?: string;
  /** Optional `extra` block for the 402 (e.g. dynamic pricing estimate). */
  extra?: Record<string, unknown>;
}

export interface X402Context {
  payerAddress: string;
  settleResult: SettlementResponseV2;
  paymentPayload?: PaymentPayloadV2;
  paymentRequirements?: PaymentRequirementsV2;
}

// Correct mainnet/testnet token contracts (asset = `${address}.${name}` in v2).
const TOKEN_CONTRACTS: Record<'mainnet' | 'testnet', Record<'sBTC' | 'USDCx', TokenContract>> = {
  mainnet: {
    sBTC: { address: 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4', name: 'sbtc-token' },
    USDCx: { address: 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE', name: 'usdcx' },
  },
  testnet: {
    sBTC: { address: 'ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT', name: 'sbtc-token' },
    USDCx: { address: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM', name: 'usdcx' },
  },
};

/** RelayRPC.sponsorPayment() over the `X402_RELAY` service binding (x402-sponsor-relay). */
type SponsorPaymentResult =
  | { success: true; txid: string; payer: string; fee: string }
  | { success: false; code: string; error: string; retryable: boolean };

interface SponsorRelay {
  sponsorPayment(
    txHex: string,
    settle: { expectedRecipient: string; minAmount: string; tokenType?: TokenType; resource?: string; method?: string },
  ): Promise<SponsorPaymentResult>;
}

/** Relay `canSponsor`, memoized per isolate so a 402 doesn't always cost a fetch. */
const SPONSOR_STATUS_TTL_MS = 60_000;
let sponsorStatus: { relayUrl: string; canSponsor: boolean; at: number } | undefined;

async function relayCanSponsor(relayUrl: string): Promise<boolean> {
  const now = Date.now();
  if (sponsorStatus?.relayUrl === relayUrl && now - sponsorStatus.at < SPONSOR_STATUS_TTL_MS) {
    return sponsorStatus.canSponsor;
  }
  let canSponsor = false;
  try {
    const res = await fetch(`${relayUrl}/status/sponsor`, { signal: AbortSignal.timeout(2000) });
    canSponsor = res.ok && ((await res.json()) as { canSponsor?: boolean }).canSponsor === true;
  } catch {
    /* unreachable relay → don't advertise sponsorship */
  }
  sponsorStatus = { relayUrl, canSponsor, at: now };
  return canSponsor;
}

/** Forget the memoized `canSponsor` so the next check asks the relay again. */
export function resetSponsorStatus(): void {
  sponsorStatus = undefined;
}

/** What the gateway needs from a signed payment tx: auth type, origin (payer) and fee. */
export interface PaymentTxInfo {
  sponsored: boolean;
  origin: string;
  nonce: bigint;
  fee: bigint;
}

export function decodePaymentTx(txHex: string | undefined, network: 'mainnet' | 'testnet'): PaymentTxInfo | null {
  if (!txHex) return null;
  try {
    const tx = deserializeTransaction(txHex.replace(/^0x/, ''));
    const sc = tx.auth.spendingCondition;
    const origin = addressToString(addressFromVersionHash(addressHashModeToVersion(sc.hashMode, network), sc.signer));
    return { sponsored: tx.auth.authType === AuthType.Sponsored, origin, nonce: BigInt(sc.nonce), fee: BigInt(sc.fee) };
  } catch {
    return null;
  }
}

/**
 * Refuse a self-paid payment while the payer already has a tx in the mempool.
 * A sponsored payment whose response was lost can still be pending; a self-paid
 * retry would take the next nonce and both could confirm (double charge). Same
 * rule as the relay's SponsorWallet.checkSender, and likewise fail closed when
 * the Stacks API can't be read. Returns a reason code, or null when clear.
 */
export async function payerPendingCheck(apiBase: string, payer: string): Promise<null | 'PAYER_TX_PENDING' | 'PAYER_NONCE_UNAVAILABLE'> {
  try {
    const res = await fetch(`${apiBase}/extended/v1/address/${payer}/nonces`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return 'PAYER_NONCE_UNAVAILABLE';
    const n = (await res.json()) as { last_mempool_tx_nonce?: number | null };
    return n.last_mempool_tx_nonce != null ? 'PAYER_TX_PENDING' : null;
  } catch {
    return 'PAYER_NONCE_UNAVAILABLE';
  }
}

/** Self-paid fee estimate (uSTX) for the payment tx, memoized per isolate. */
const FEE_ESTIMATE_TTL_MS = 60_000;
const feeEstimates = new Map<string, { fee: string | undefined; at: number }>();
// Placeholder principal for the estimate payload (only its size/cost matter).
const FEE_PLACEHOLDER = { mainnet: 'SP000000000000000000002Q6VF78', testnet: 'ST000000000000000000002AMW42H' };

export async function estimateSelfPaidFee(apiBase: string, tokenType: TokenType, network: 'mainnet' | 'testnet'): Promise<string | undefined> {
  const key = `${apiBase}|${network}|${tokenType}`;
  const now = Date.now();
  const hit = feeEstimates.get(key);
  if (hit && now - hit.at < FEE_ESTIMATE_TTL_MS) return hit.fee;
  let fee: string | undefined;
  try {
    const who = FEE_PLACEHOLDER[network];
    const payload = tokenType === 'STX'
      ? createTokenTransferPayload(who, 1n)
      : createContractCallPayload(TOKEN_CONTRACTS[network][tokenType].address, TOKEN_CONTRACTS[network][tokenType].name, 'transfer', [
          uintCV(1), standardPrincipalCV(who), standardPrincipalCV(who), someCV(bufferCV(new Uint8Array(34))),
        ]);
    const res = await fetch(`${apiBase}/v2/fees/transaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction_payload: serializePayload(payload), estimated_len: 350 }),
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const est = ((await res.json()) as { estimations?: Array<{ fee?: number }> }).estimations;
      const mid = est?.[1]?.fee ?? est?.[0]?.fee;
      if (typeof mid === 'number' && mid > 0) fee = String(mid);
    }
  } catch {
    /* no estimate → omit the field */
  }
  feeEstimates.set(key, { fee, at: now });
  return fee;
}

// Bindings are `any` so these helpers compose with any app Env.
type Ctx = Context<{ Bindings: any; Variables: { x402?: X402Context; quote?: unknown; route?: unknown; legion?: { fees?: string; treasury?: string; gov?: string } } }>;

function encodeB64Json(obj: unknown): string {
  const json = JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  return btoa(json);
}

function decodeB64Json<T>(b64: string): T | null {
  try {
    return JSON.parse(atob(b64)) as T;
  } catch {
    return null;
  }
}

function getAssetV2(tokenType: TokenType, network: 'mainnet' | 'testnet'): string {
  if (tokenType === 'STX') return 'STX';
  const c = TOKEN_CONTRACTS[network][tokenType];
  return `${c.address}.${c.name}`;
}

/** Effective token type from the `X-PAYMENT-TOKEN-TYPE` header or `tokenType` query. */
export function resolveTokenType(c: Ctx, fallback: TokenType): TokenType {
  const raw = (c.req.header('X-PAYMENT-TOKEN-TYPE') || c.req.query('tokenType') || '').toUpperCase();
  if (raw === 'SBTC') return 'sBTC';
  if (raw === 'USDCX') return 'USDCx';
  if (raw === 'STX') return 'STX';
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────
// Option B — Legion fee-rail settlement (verify an on-chain `route` receipt).
// ─────────────────────────────────────────────────────────────────────────

interface LegionRouteCfg {
  amount: string;       // quoted routed amount (sBTC base units)
  recipient: string;    // provider that must receive the 92% leg (route `to`)
  network: 'mainnet' | 'testnet';
  networkV2: string;
  feeContract?: string; // per-model legion-fees-<family>; falls back to env.LEGION_FEES
  treasury?: string;    // per-model legion-treasury-<family>; falls back to env.LEGION_TREASURY
}

function stacksApiBase(env: any, network: 'mainnet' | 'testnet'): string {
  return env.STACKS_API || (network === 'mainnet' ? 'https://api.hiro.so' : 'https://api.testnet.hiro.so');
}

/** Parse a uint Clarity `repr` like "u1000000" → bigint. */
function uintRepr(repr: string | undefined): bigint | null {
  if (!repr) return null;
  const m = /^u(\d+)$/.exec(repr.trim());
  return m ? BigInt(m[1]) : null;
}

/** A principal `repr` is rendered with a leading quote, e.g. "'ST..." — strip it. */
function principalRepr(repr: string | undefined): string {
  return (repr ?? '').trim().replace(/^'/, '');
}

function findArg(args: any[] | undefined, name: string, idx: number): any {
  if (!Array.isArray(args)) return undefined;
  return args.find((a) => a?.name === name) ?? args[idx];
}

/**
 * Settle by verifying an already-broadcast `legion-fees.route` transaction.
 * No header → 402 advertising the fee rail. Header present → verify on-chain.
 */
async function settleViaLegionRoute(c: Ctx, cfg: LegionRouteCfg): Promise<Response | null> {
  const env = c.env;
  const feeContract: string = cfg.feeContract || env.LEGION_FEES;          // per-model legion-fees-<family>, else legacy
  const treasury: string | undefined = cfg.treasury || env.LEGION_TREASURY; // per-model treasury, else legacy
  const token: string = env.LEGION_SBTC;                       // sBTC the rail accepts (Faktory token)
  // route reverts u430 unless 8% rounds to ≥1 base unit; floor the quote so cheap
  // calls still carry a non-zero skim. LEGION_MIN_AMOUNT overrides the default.
  const minAmount = BigInt(env.LEGION_MIN_AMOUNT || '1250');
  const quoted = (() => {
    const a = BigInt(cfg.amount || '0');
    return a > minAmount ? a : minAmount;
  })();

  const txid = c.req.header('X-PAYMENT-ROUTE-TXID');

  // ---- discovery: advertise the fee-rail challenge --------------------------
  if (!txid) {
    const required = {
      x402Version: 2,
      scheme: 'legion-route',
      resource: { url: c.req.path, description: `Legion fee-rail payment - ${c.req.path}`, mimeType: 'application/json' },
      accepts: [{
        scheme: 'legion-route',
        network: cfg.networkV2,
        amount: quoted.toString(),
        asset: token,
        payTo: cfg.recipient,
        payVia: `${feeContract}.route`,
        feeContract,
        treasury,
        maxTimeoutSeconds: 300,
        description: 'Call legion-fees.route(sbtc, amount, payTo); 8% -> treasury, 92% -> payTo. Retry with X-PAYMENT-ROUTE-TXID.',
      }],
    };
    c.header(X402_HEADERS.PAYMENT_REQUIRED, encodeB64Json(required));
    return c.json(required, 402);
  }

  // ---- credit ledger: ONE on-chain top-up funds MANY off-chain calls --------
  // The only on-chain event is the top-up `route` (treasury skims 8%, provider
  // paid 92% upfront — non-custodial). Per-call metering is off-chain in KV, so
  // no gas / no Stacks tx per inference. This is what makes the rail usable.
  const kv = env.PROVIDERS as { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void> } | undefined;
  const creditKey = `credit:${txid}`;
  const openedKey = `opened:${txid}`;
  const creditTtl = Number(env.LEGION_CREDIT_TTL || 86400); // seconds (24h)
  const now = Date.now();

  const accept = (payer: string, remaining: bigint) => {
    c.set('x402', {
      payerAddress: payer,
      settleResult: { success: true, transaction: txid, network: cfg.networkV2, payer },
    });
    c.header(X402_HEADERS.PAYMENT_RESPONSE, encodeB64Json({ success: true, transaction: txid, scheme: 'legion-route', payer, creditRemaining: remaining.toString() }));
    c.header('X-PAYER-ADDRESS', payer);
    c.header('X-LEGION-CREDIT-REMAINING', remaining.toString());
    return null;
  };

  // Existing credit → meter off-chain, zero Stacks calls.
  if (kv) {
    const raw = await kv.get(creditKey);
    if (raw) {
      const cr = JSON.parse(raw);
      if (now > cr.expiresAt) return c.json({ error: 'Credit expired — top up again', code: 'CREDIT_EXPIRED', txid }, 402);
      const remaining = BigInt(cr.remaining);
      if (remaining < quoted) return c.json({ error: 'Credit exhausted — top up again', code: 'CREDIT_EXHAUSTED', txid, remaining: cr.remaining, callPrice: quoted.toString() }, 402);
      const left = remaining - quoted;
      cr.remaining = left.toString();
      await kv.put(creditKey, JSON.stringify(cr), { expirationTtl: creditTtl });
      return accept(cr.payer, left);
    }
    // Credit lifetime already used → never re-open from the same txid (anti-replay after TTL).
    if (await kv.get(openedKey)) {
      return c.json({ error: 'Receipt already consumed — top up again', code: 'RECEIPT_REPLAY', txid }, 402);
    }
  }

  // ---- new top-up: verify the route tx on-chain (once) ----------------------
  let tx: any;
  try {
    const r = await fetch(`${stacksApiBase(env, cfg.network)}/extended/v1/tx/${txid}`);
    if (!r.ok) return c.json({ error: 'Receipt tx not found', code: 'RECEIPT_NOT_FOUND', txid, status: r.status }, 402);
    tx = await r.json();
  } catch (e) {
    return c.json({ error: 'Stacks API lookup failed', code: 'RECEIPT_LOOKUP_ERROR', details: String(e) }, 502);
  }

  const fail = (reason: string, extra: Record<string, unknown> = {}) =>
    c.json({ error: 'Receipt verification failed', code: 'RECEIPT_INVALID', reason, txid, ...extra }, 402);

  if (tx.tx_status !== 'success') return fail(`tx_status=${tx.tx_status}`);
  if (tx.tx_type !== 'contract_call') return fail(`tx_type=${tx.tx_type}`);

  // Reorg / mempool guard: only honor a tx the API considers canonical and
  // anchored. Optionally require N confirmations of depth (LEGION_MIN_CONF).
  if (tx.canonical === false || tx.is_unanchored === true) return fail('not canonical/anchored');
  const minConf = Number(env.LEGION_MIN_CONF || '0');
  if (minConf > 0 && Number.isFinite(tx.block_height)) {
    try {
      const tr = await fetch(`${stacksApiBase(env, cfg.network)}/extended/v1/block?limit=1`);
      const tip = tr.ok ? (await tr.json())?.results?.[0]?.height : undefined;
      if (Number.isFinite(tip) && tip - tx.block_height < minConf) {
        return fail('insufficient confirmations', { conf: tip - tx.block_height, need: minConf });
      }
    } catch { /* tip lookup best-effort; canonical guard already applied */ }
  }

  const call = tx.contract_call ?? {};
  if (call.contract_id !== feeContract) return fail('wrong contract', { got: call.contract_id, want: feeContract });
  if (call.function_name !== 'route') return fail('wrong function', { got: call.function_name });

  const args = call.function_args as any[] | undefined;
  const ftArg = principalRepr(findArg(args, 'ft', 0)?.repr);
  const amountArg = uintRepr(findArg(args, 'amount', 1)?.repr);
  const toArg = principalRepr(findArg(args, 'to', 2)?.repr);

  if (token && ftArg !== token) return fail('wrong token', { got: ftArg, want: token });
  if (toArg !== cfg.recipient) return fail('wrong recipient', { got: toArg, want: cfg.recipient });
  if (amountArg === null || amountArg < quoted) return fail('underpaid', { got: amountArg?.toString(), want: quoted.toString() });

  // ---- accept: open an off-chain credit funded by this one top-up -----------
  // remaining = full routed amount minus this first call. Later calls draw down
  // the same credit with no further on-chain tx.
  const payer = tx.sender_address || 'unknown';
  const remaining = amountArg - quoted;
  if (kv) {
    await kv.put(openedKey, '1', { expirationTtl: 60 * 60 * 24 * 30 });
    await kv.put(creditKey, JSON.stringify({ payer, provider: cfg.recipient, remaining: remaining.toString(), total: amountArg.toString(), expiresAt: now + creditTtl * 1000 }), { expirationTtl: creditTtl });
  }
  return accept(payer, remaining);
}

/**
 * Core x402 v2 settlement. Returns null on success (after attaching the payment
 * context) or a Response (402 / error) the caller must return.
 */
async function settle(c: Ctx, config: X402Config): Promise<Response | null> {
  const env = c.env;
  const network = (env.NETWORK || 'testnet') as 'mainnet' | 'testnet';
  const relayUrl = env.RELAY_URL || (network === 'mainnet' ? 'https://x402-relay.aibtc.com' : 'https://x402-relay.aibtc.dev');
  const recipient = config.payTo || env.RECIPIENT_ADDRESS;
  const tokenType = config.tokenType;
  const networkV2 = networkToCAIP2(network);

  // DEV-ONLY bypass, hard-gated to non-mainnet (see SKIP_PAYMENT).
  if (env.SKIP_PAYMENT === 'true' && network !== 'mainnet') {
    c.set('x402', {
      payerAddress: 'dev-bypass',
      settleResult: { success: true, transaction: 'dev-skip', network: networkV2, payer: 'dev-bypass' },
    });
    c.header('X-PAYER-ADDRESS', 'dev-bypass');
    return null;
  }

  // Option B — Legion fee-rail scheme. When LEGION_FEES is configured, payment
  // settles through the Legion's `legion-fees.route` (8% → treasury, 92% →
  // provider) instead of x402-stacks's direct transfer. x402-stacks@2.0.3 can't
  // carry an arbitrary contract-call as X-PAYMENT, so the agent broadcasts the
  // route call itself and we VERIFY the settled txid on-chain. See the gist
  // legion-inference-1.0.md §2.
  // Resolve the per-model legion set on the route handler (house/community both
  // set it). The rail activates when a per-model legion OR the legacy env exists.
  const ml = (c.get('legion') as { fees?: string; treasury?: string } | undefined);
  const feeContract = ml?.fees || env.LEGION_FEES;
  if (feeContract) {
    return settleViaLegionRoute(c, {
      amount: config.amount, recipient, network, networkV2,
      feeContract, treasury: ml?.treasury || env.LEGION_TREASURY,
    });
  }

  const paymentRequirements: PaymentRequirementsV2 = {
    scheme: 'exact',
    network: networkV2,
    amount: config.amount,
    asset: getAssetV2(tokenType, network),
    payTo: recipient,
    maxTimeoutSeconds: 300,
  };
  // Advertise gas sponsorship when the relay's service binding and sponsor address
  // are wired and the relay reports it can sponsor. x402-stacks keys on
  // `extra.feePayer` (`sponsored` is kept for other readers): clients then sign with
  // `sponsored: true, fee: 0` and the relay pays the STX fee.
  const relay: SponsorRelay | undefined = env.X402_RELAY;
  const feePayer: string | undefined = env.X402_SPONSOR_FEE_PAYER;
  // Not sponsoring → the client pays the STX fee on top of `amount`; advertise an
  // estimate (`extra.estimatedFeeUstx`) so it can apply its own ceiling.
  const apiBase = stacksApiBase(env, network);
  const selfPaidExtra = async () => {
    const estimatedFeeUstx = await estimateSelfPaidFee(apiBase, tokenType, network);
    return estimatedFeeUstx ? { estimatedFeeUstx } : {};
  };
  const canSponsor = !!(relay && feePayer && (await relayCanSponsor(relayUrl)));
  const sponsor = canSponsor ? { feePayer, sponsored: true } : await selfPaidExtra();
  const extra = { ...(config.extra ?? {}), ...sponsor };
  if (Object.keys(extra).length) paymentRequirements.extra = extra;

  // A sponsored settle failed. If the relay can no longer sponsor, hand back
  // self-paid requirements so the client can re-sign in one round trip instead
  // of waiting out the canSponsor memo.
  const sponsorFailureHint = async (): Promise<Record<string, unknown>> => {
    resetSponsorStatus();
    if (await relayCanSponsor(relayUrl)) return {};
    const selfPaid: PaymentRequirementsV2 = { ...paymentRequirements, extra: { ...(config.extra ?? {}), ...(await selfPaidExtra()) } };
    return { retrySelfPaid: true, accepts: [selfPaid] };
  };

  const sig = c.req.header(X402_HEADERS.PAYMENT_SIGNATURE);

  if (!sig) {
    const required: PaymentRequiredV2 = {
      x402Version: 2,
      resource: { url: c.req.path, description: `x402 API - ${c.req.path}`, mimeType: 'application/json' },
      accepts: [paymentRequirements],
    };
    c.header(X402_HEADERS.PAYMENT_REQUIRED, encodeB64Json(required));
    return c.json(required, 402);
  }

  const payload = decodeB64Json<PaymentPayloadV2>(sig);
  if (!payload || payload.x402Version !== 2) {
    return c.json({ error: 'Invalid payment-signature header', code: X402_ERROR_CODES.INVALID_PAYLOAD }, 400);
  }

  const txInfo = decodePaymentTx(payload.payload?.transaction, network);
  if (!txInfo) {
    return c.json({ error: 'Invalid payment transaction', code: X402_ERROR_CODES.INVALID_PAYLOAD }, 400);
  }

  let settleResult: SettlementResponseV2;
  if (relay && txInfo.sponsored) {
    // Sponsored tx → the relay co-signs, pays the fee and broadcasts (binding-only;
    // the public /settle refuses an empty sponsor slot). Self-paid txs fall through.
    let sponsored: SponsorPaymentResult;
    try {
      sponsored = await relay.sponsorPayment(payload.payload.transaction, {
        expectedRecipient: recipient,
        minAmount: config.amount,
        tokenType,
        resource: c.req.path,
        method: c.req.method,
      });
    } catch (error) {
      return c.json({
        error: 'Settlement relay error',
        code: X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR,
        details: String(error),
        ...(await sponsorFailureHint()),
      }, 502);
    }
    if (!sponsored.success) {
      return c.json({
        error: 'Payment settlement failed',
        code: X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR,
        reason: sponsored.code,
        details: sponsored.error,
        retryable: sponsored.retryable,
        asset: paymentRequirements.asset,
        network: networkV2,
        ...(await sponsorFailureHint()),
      }, sponsored.retryable ? 503 : 402);
    }
    settleResult = { success: true, transaction: sponsored.txid, network: networkV2, payer: sponsored.payer };
  } else {
    // Self-paid: the relay broadcasts as-is, so guard against a still-pending
    // earlier payment from this payer (see payerPendingCheck).
    const pending = await payerPendingCheck(apiBase, txInfo.origin);
    if (pending) {
      return c.json({
        error: pending === 'PAYER_TX_PENDING'
          ? 'Payer has a pending transaction; retry once it confirms or drops'
          : 'Could not read payer nonce state; retry shortly',
        code: X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR,
        reason: pending,
        retryable: true,
        payer: txInfo.origin,
      }, pending === 'PAYER_TX_PENDING' ? 409 : 503);
    }
    try {
      const verifier = new X402PaymentVerifier(relayUrl);
      settleResult = await verifier.settle(payload, { paymentRequirements });
    } catch (error) {
      return c.json({
        error: 'Settlement relay error',
        code: X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR,
        details: String(error),
      }, 502);
    }
  }

  if (!settleResult.success) {
    return c.json({
      error: 'Payment settlement failed',
      code: X402_ERROR_CODES.UNEXPECTED_SETTLE_ERROR,
      reason: settleResult.errorReason,
      asset: paymentRequirements.asset,
      network: networkV2,
    }, 402);
  }

  const payerAddress = settleResult.payer || 'unknown';
  c.set('x402', { payerAddress, settleResult, paymentPayload: payload, paymentRequirements });
  c.header(X402_HEADERS.PAYMENT_RESPONSE, encodeB64Json(settleResult));
  c.header('X-PAYER-ADDRESS', payerAddress);
  return null;
}

/** Fixed-price x402 middleware (token overridable via header/query). */
export function x402Middleware(config: X402Config): MiddlewareHandler {
  return async (c: Ctx, next: Next) => {
    const tokenType = resolveTokenType(c, config.tokenType);
    const response = await settle(c, { ...config, tokenType });
    if (response) return response;
    await next();
  };
}

/**
 * Dynamic-price x402 middleware. `resolvePrice` inspects the request (model in
 * the body) and returns the X402Config to charge, or a Response to short-circuit.
 */
export function x402DynamicMiddleware(
  resolvePrice: (c: Ctx, tokenType: TokenType) => Promise<X402Config | Response> | X402Config | Response,
): MiddlewareHandler {
  return async (c: Ctx, next: Next) => {
    const tokenType = resolveTokenType(c, 'sBTC');
    const resolved = await resolvePrice(c, tokenType);
    if (resolved instanceof Response) return resolved;
    const response = await settle(c, resolved);
    if (response) return response;
    await next();
  };
}
