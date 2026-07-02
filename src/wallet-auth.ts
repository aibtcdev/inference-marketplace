/**
 * Wallet-signature auth.
 *
 * A provider proves ownership by signing a short message with the Stacks wallet
 * whose address is the provider's `payoutAddress`. The browser signs it via
 * `@stacks/connect` → `request('stx_signMessage', { message })`; an agent signs
 * the same string via the MCP `stacks_sign_message`. Both return `{ signature,
 * publicKey }`.
 *
 * We verify here with `@stacks/encryption`'s one-call `verifyMessageSignatureRsv`
 * (no hand-rolled crypto, no encoding), then derive the signer's address with
 * `@stacks/transactions` and require it to equal the expected payout address.
 * A timestamp (in the signed message) + one-time nonce prevent replay.
 */
import { verifyMessageSignatureRsv } from '@stacks/encryption';
import { getAddressFromPublicKey } from '@stacks/transactions';

export type StacksNetwork = 'mainnet' | 'testnet';
/** Max clock skew between the signed timestamp and now (seconds). */
export const AUTH_SKEW_SECONDS = 300;

export type AuthAction = 'register' | 'update' | 'reveal-key';

export function toNetwork(network?: string): StacksNetwork {
  return network === 'mainnet' ? 'mainnet' : 'testnet';
}

/** The exact message the wallet signs. The client and server MUST build this
 *  identically. Human-readable so the wallet can display what's being authorized;
 *  `action` scopes the signature (an update sig can't reveal a key) and
 *  `timestamp` bounds its lifetime. */
export function authMessage(action: AuthAction, providerId: string, timestamp: number): string {
  return `Inference Marketplace\nAction: ${action}\nProvider: ${providerId}\nTimestamp: ${timestamp}`;
}

export interface WalletAuthInput {
  network: StacksNetwork;
  action: AuthAction;
  providerId: string;
  /** Unix seconds, from the signed message (sent alongside the signature). */
  timestamp: number;
  /** RSV signature hex from the wallet (`0x…` accepted). */
  signature: string;
  /** Compressed public key hex the wallet returned with the signature. */
  publicKey: string;
}

export type WalletAuthResult =
  | { ok: true; address: string }
  | { ok: false; error: string };

/**
 * Verify a wallet-signed auth message and return the signer's Stacks address.
 * The caller compares that address to the provider's payoutAddress and handles
 * the one-time nonce. Supplying `publicKey` is safe: we derive the address from
 * it, so a caller can't pass someone else's key — it would resolve to a
 * different address and fail the payout-address check.
 */
export function recoverWalletAuth(input: WalletAuthInput, now: number): WalletAuthResult {
  if (!input.signature) return { ok: false, error: 'missing signature' };
  if (!input.publicKey) return { ok: false, error: 'missing publicKey' };
  if (!Number.isFinite(input.timestamp)) return { ok: false, error: 'missing/invalid timestamp' };
  if (Math.abs(now - input.timestamp) > AUTH_SKEW_SECONDS) {
    return { ok: false, error: 'signature expired — re-sign (timestamp outside the allowed window)' };
  }

  const message = authMessage(input.action, input.providerId, input.timestamp);
  const signature = input.signature.replace(/^0x/, ''); // wallet returns 0x-prefixed; verifier wants bare hex
  let valid: boolean;
  try {
    valid = verifyMessageSignatureRsv({ message, signature, publicKey: input.publicKey });
  } catch (e) {
    return { ok: false, error: `invalid signature: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!valid) return { ok: false, error: 'signature does not verify for the given public key' };

  return { ok: true, address: getAddressFromPublicKey(input.publicKey, input.network) };
}
