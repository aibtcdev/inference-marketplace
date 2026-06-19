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

export type TokenType = 'STX' | 'sBTC' | 'USDCx';

export interface TokenContract {
  address: string;
  name: string;
}

export interface X402Config {
  amount: string;
  tokenType: TokenType;
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

// Bindings are `any` so these helpers compose with any app Env.
type Ctx = Context<{ Bindings: any; Variables: { x402?: X402Context; quote?: unknown } }>;

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

/**
 * Core x402 v2 settlement. Returns null on success (after attaching the payment
 * context) or a Response (402 / error) the caller must return.
 */
async function settle(c: Ctx, config: X402Config): Promise<Response | null> {
  const env = c.env;
  const network = (env.NETWORK || 'testnet') as 'mainnet' | 'testnet';
  const relayUrl = env.RELAY_URL || (network === 'mainnet' ? 'https://x402-relay.aibtc.com' : 'https://x402-relay.aibtc.dev');
  const recipient = env.RECIPIENT_ADDRESS;
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

  const paymentRequirements: PaymentRequirementsV2 = {
    scheme: 'exact',
    network: networkV2,
    amount: config.amount,
    asset: getAssetV2(tokenType, network),
    payTo: recipient,
    maxTimeoutSeconds: 300,
    ...(config.extra ? { extra: config.extra } : {}),
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

  let settleResult: SettlementResponseV2;
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
