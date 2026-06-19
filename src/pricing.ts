/**
 * Dynamic pricing engine.
 *
 * Two axes of "dynamic":
 *   1. By model  — price tracks the model's serving cost (costPer1kUsd in the
 *                  catalog: your GPU $/hr ÷ throughput). Big models cost more.
 *   2. By BTC/STX — that USD price is converted to the payment token's base
 *                  units at the live spot rate, so the *real* (USD) price stays
 *                  stable while the sat/STX amount floats with the market.
 *
 *   price_usd = (prompt_tokens + max_tokens)/1000 * costPer1kUsd * markup
 *
 * Quotes are UPFRONT and sized to max_tokens (the cap), so the house never
 * underprices a call. Unused output tokens are overpaid until metered
 * settlement (Phase 1.5: deposit -> read actual usage -> settle exact).
 *
 * markup = multiple of cost charged to the agent. 1.5 => 50% margin.
 */

import type { TokenType } from './x402-middleware';

const COINBASE = 'https://api.coinbase.com/v2/prices';

export const DEFAULT_MARKUP = 1.5;

// Used only if a price feed is unreachable, so the gateway degrades instead of
// failing. Refreshed by the live feed on the next request.
const FALLBACK_BTC_USD = 100_000;
const FALLBACK_STX_USD = 1;

const PRICE_TTL_MS = 60_000; // spot prices: 60s

interface Entry<T> { value: T; ts: number; }

// Module-level cache. Persists across requests within a warm Worker isolate.
const cache: { btc?: Entry<number>; stx?: Entry<number> } = {};

async function fetchSpot(pair: string): Promise<number> {
  const res = await fetch(`${COINBASE}/${pair}/spot`);
  if (!res.ok) throw new Error(`Coinbase ${pair} ${res.status}`);
  const data = (await res.json()) as { data?: { amount?: string } };
  const amt = Number(data.data?.amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error(`Bad ${pair} amount`);
  return amt;
}

export async function getBtcUsd(): Promise<number> {
  const now = Date.now();
  if (cache.btc && now - cache.btc.ts < PRICE_TTL_MS) return cache.btc.value;
  try {
    const v = await fetchSpot('BTC-USD');
    cache.btc = { value: v, ts: now };
    return v;
  } catch {
    return cache.btc?.value ?? FALLBACK_BTC_USD;
  }
}

export async function getStxUsd(): Promise<number> {
  const now = Date.now();
  if (cache.stx && now - cache.stx.ts < PRICE_TTL_MS) return cache.stx.value;
  try {
    const v = await fetchSpot('STX-USD');
    cache.stx = { value: v, ts: now };
    return v;
  } catch {
    return cache.stx?.value ?? FALLBACK_STX_USD;
  }
}

/** Rough token estimate (~4 chars/token) for upfront prompt sizing. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Convert a USD price to the smallest unit of a token (string, 1-unit floor). */
export async function usdToBaseUnits(usd: number, tokenType: TokenType): Promise<string> {
  if (tokenType === 'USDCx') {
    // Stablecoin, 6 decimals — finest granularity, prices cheap calls exactly.
    return String(Math.max(1, Math.ceil(usd * 1e6)));
  }
  if (tokenType === 'STX') {
    const stx = await getStxUsd();
    return String(Math.max(1, Math.ceil((usd / stx) * 1e6))); // 6 decimals
  }
  // sBTC — 8 decimals (1 base unit = 1 sat). 1-sat floor.
  const btc = await getBtcUsd();
  return String(Math.max(1, Math.ceil((usd / btc) * 1e8)));
}

export interface Quote {
  amount: string;     // payment token base units (what goes in the 402)
  tokenType: TokenType;
  priceUsd: number;   // post-markup USD price
  costUsd: number;    // pre-markup serving cost estimate
  markup: number;
  btcUsd?: number;    // rate used, when paying in sBTC
  detail: { model: string; promptTokens: number; maxTokens: number; costPer1kUsd: number };
}

/**
 * Produce an upfront price quote for a model + token. `costPer1kUsd` is the
 * model's serving cost from the catalog; `markup` overrides the default.
 */
export async function quotePrice(opts: {
  modelId: string;
  costPer1kUsd: number;
  promptText: string;
  maxTokens: number;
  tokenType: TokenType;
  markup?: number;
}): Promise<Quote> {
  const markup = opts.markup && opts.markup > 0 ? opts.markup : DEFAULT_MARKUP;

  const promptTokens = estimateTokens(opts.promptText);
  const maxTokens = opts.maxTokens;

  const costUsd = ((promptTokens + maxTokens) / 1000) * opts.costPer1kUsd;
  const priceUsd = costUsd * markup;
  const amount = await usdToBaseUnits(priceUsd, opts.tokenType);

  const quote: Quote = {
    amount,
    tokenType: opts.tokenType,
    priceUsd,
    costUsd,
    markup,
    detail: { model: opts.modelId, promptTokens, maxTokens, costPer1kUsd: opts.costPer1kUsd },
  };
  if (opts.tokenType === 'sBTC') quote.btcUsd = await getBtcUsd();
  return quote;
}

/** Realized serving cost (USD) from actual token usage — for the receipt. */
export function realizedCostUsd(totalTokens: number, costPer1kUsd: number): number {
  return (totalTokens / 1000) * costPer1kUsd;
}
