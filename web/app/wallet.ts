"use client";

// Thin wrapper over @stacks/connect for the dashboard: connect a wallet, read
// the connected STX address, and sign the auth message the gateway verifies.
//
// @stacks/connect is listed in next.config transpilePackages so it bundles
// cleanly under Turbopack + static export. The synchronous read path used by
// useSyncExternalStore reads @stacks/connect's localStorage key directly so it
// stays SSR-safe (no window access during prerender).
import { useSyncExternalStore } from "react";
import { connect, disconnect, getLocalStorage, isConnected, request } from "@stacks/connect";

type ConnectResult = Awaited<ReturnType<typeof connect>>;

export type AuthAction = "register" | "update" | "reveal-key";

/** Which network a Stacks address belongs to (SP/SM = mainnet, ST/SN = testnet). */
export function addressNetwork(addr: string | null): "mainnet" | "testnet" | null {
  if (!addr) return null;
  if (addr.startsWith("SP") || addr.startsWith("SM")) return "mainnet";
  if (addr.startsWith("ST") || addr.startsWith("SN")) return "testnet";
  return null;
}

/** STX addresses from connect()'s flat `addresses[]` response. */
function stxFromResult(res: ConnectResult | undefined): string[] {
  return (res?.addresses ?? [])
    .map((a) => a?.address)
    .filter((x): x is string => typeof x === "string" && /^S[PTMN]/.test(x));
}

/** STX addresses persisted by @stacks/connect (the official reader decodes and
 *  parses localStorage for us — never hand-roll this). Used to restore the
 *  session after a page reload. */
function readStoredAddresses(): string[] {
  if (typeof window === "undefined" || !isConnected()) return [];
  return (getLocalStorage()?.addresses?.stx ?? [])
    .map((a) => a?.address)
    .filter((x): x is string => typeof x === "string" && /^S[PTMN]/.test(x));
}

// Connected wallet = external state via useSyncExternalStore. Stored as a stable
// array reference (only replaced on connect/disconnect) so snapshots don't churn.
const EMPTY: string[] = [];
let currentAddresses: string[] | undefined = undefined;
const listeners = new Set<() => void>();
function emitWalletChange() {
  for (const l of listeners) l();
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getStxAddresses(): string[] {
  if (currentAddresses === undefined) currentAddresses = readStoredAddresses();
  return currentAddresses;
}

/** Reactive list of the wallet's STX addresses (empty when not connected). */
export function useWalletAddresses(): string[] {
  return useSyncExternalStore(subscribe, getStxAddresses, () => EMPTY);
}

/** Open the wallet; returns its STX addresses and updates useWalletAddresses(). */
export async function connectWallet(): Promise<string[]> {
  const res = await connect(); // persists to localStorage (enableLocalStorage defaults to true)
  let list = stxFromResult(res);
  if (!list.length) list = readStoredAddresses();
  currentAddresses = list;
  emitWalletChange();
  return list;
}

export function disconnectWallet(): void {
  disconnect();
  currentAddresses = EMPTY;
  emitWalletChange();
}

function authMessage(action: AuthAction, providerId: string, timestamp: number): string {
  return `Inference Marketplace\nAction: ${action}\nProvider: ${providerId}\nTimestamp: ${timestamp}`;
}

export type AuthHeaders = {
  "X-Stacks-Signature": string;
  "X-Stacks-Public-Key": string;
  "X-Stacks-Timestamp": string;
};

/** Prompt the wallet to sign the action message and return the gateway headers. */
export async function signAuthHeaders(action: AuthAction, providerId: string): Promise<AuthHeaders> {
  const timestamp = Math.floor(Date.now() / 1000);
  const res = await request("stx_signMessage", { message: authMessage(action, providerId, timestamp) });
  return {
    "X-Stacks-Signature": res.signature,
    "X-Stacks-Public-Key": res.publicKey,
    "X-Stacks-Timestamp": String(timestamp),
  };
}
