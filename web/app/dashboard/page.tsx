"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast, Toaster } from "sonner";
import { addressNetwork, connectWallet, disconnectWallet, useWalletAddresses } from "../wallet";
import { GATEWAY, trunc, MyEndpoints } from "../shared";
import type { Provider } from "../shared";

export default function Dashboard() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [network, setNetwork] = useState("testnet");
  const addresses = useWalletAddresses();
  const wallet = addresses[0] ?? null;
  const walletNet = addressNetwork(wallet);
  const netMismatch = !!wallet && !!walletNet && walletNet !== network;

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${GATEWAY}/v1/providers`);
      const d = await r.json();
      setProviders(d.data || []);
    } catch { /* offline */ }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    fetch(`${GATEWAY}/`).then((r) => r.json()).then((d) => { if (d?.network) setNetwork(String(d.network)); }).catch(() => { /* keep default */ });
  }, []);

  const mine = useMemo(
    () => (wallet ? providers.filter((p) => p.payoutAddress === wallet) : []),
    [providers, wallet],
  );

  const onConnect = useCallback(async () => {
    try {
      const addr = (await connectWallet())[0] ?? null;
      const net = addressNetwork(addr);
      if (addr && net && net !== network) toast.error(`Your wallet is on ${net} — switch it to ${network} to manage endpoints.`);
      else if (addr) toast.success(`Connected ${addr.slice(0, 6)}…${addr.slice(-4)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/cancel|reject|closed|denied/i.test(msg)) toast.error(msg || "Couldn't open a wallet. Is a Stacks wallet (Leather/Xverse) installed?");
    }
  }, [network]);
  const onDisconnect = useCallback(() => { disconnectWallet(); }, []);

  return (
    <div className="min-h-screen overflow-x-hidden">
      <Toaster position="top-center" theme="dark" richColors />
      <header className="sticky top-0 z-20 border-b border-[#23262d] bg-[#08090a]/85 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-4 py-3 sm:px-5 sm:py-3.5">
          <div className="flex items-center gap-2 sm:gap-3">
            <Link href="/" title="Back to marketplace" className="group flex items-center gap-1.5 rounded-lg border border-[#23262d] bg-[#101216] px-2.5 py-2 text-[12px] text-[#9aa3af] transition-colors hover:border-[#33373f] hover:text-[#f2f4f7]">
              <span aria-hidden className="text-[13px] transition-transform group-hover:-translate-x-0.5">←</span>
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-[#f7931a] text-[11px] font-bold text-[#1a1206]">⚡</span>
              <span className="hidden sm:inline">Marketplace</span>
            </Link>
            <span className="wide whitespace-nowrap text-[15px] font-medium tracking-tight">Dashboard</span>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider ${network === "mainnet" ? "border-[#123a1c] bg-[#06140b] text-[#35c759]" : "border-[#3a2f12] bg-[#1a1206] text-[#f7931a]"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${network === "mainnet" ? "bg-[#35c759]" : "bg-[#f7931a]"}`} />
              {network}
            </span>
            {wallet ? (
              <button onClick={onDisconnect} title={`Connected: ${wallet}\nTap to disconnect`} className="mono shrink-0 rounded-lg border border-[#23262d] bg-[#101216] px-3 py-2 text-[12px] text-[#9aa3af] transition-colors hover:text-[#f2f4f7]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#35c759] inline-block mr-1.5 align-middle" />
                {trunc(wallet)}
              </button>
            ) : (
              <button onClick={onConnect} className="shrink-0 rounded-lg bg-[#f7931a] px-3 py-2 text-[13px] font-medium text-[#1a1206] transition-opacity hover:opacity-90">Connect wallet</button>
            )}
          </div>
        </div>
      </header>

      {netMismatch && (
        <div className="border-b border-[#ffbf2e]/30 bg-[#ffbf2e]/[0.08] px-5 py-2.5 text-center text-xs text-[#ffce6b]">
          Your wallet is on <b>{walletNet}</b>, but this marketplace runs on <b>{network}</b>. Switch your wallet&apos;s network to {network} to manage endpoints.
        </div>
      )}

      <main className="mx-auto max-w-3xl px-5 py-10">
        {!wallet ? (
          <div className="rounded-xl border border-dashed border-[#23262d] bg-[#101216] p-12 text-center">
            <p className="text-[#9aa3af]">Connect your wallet to see the endpoints paid to it.</p>
            <button onClick={onConnect} className="mt-3 rounded-lg bg-[#f7931a] px-4 py-2 text-sm font-medium text-[#1a1206] hover:opacity-90">Connect wallet</button>
          </div>
        ) : (
          <MyEndpoints items={mine} onChanged={load} onRegister={() => { window.location.href = "/"; }} />
        )}
      </main>
    </div>
  );
}
