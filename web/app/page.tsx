"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { toast, Toaster } from "sonner";
import { addressNetwork, connectWallet, disconnectWallet, signAuthHeaders, useWalletAddresses } from "./wallet";
import { GATEWAY, STATUS, trunc, formatPrice, priceToBaseUnits, PriceInput } from "./shared";
import type { Provider, PayToken } from "./shared";

// The models we run on-chain legions for. A provider picks one at registration so
// it maps 1:1 to its legion (fees/treasury/gov). Keep in sync with the gateway's
// src/model-legions.ts families (qwen/deepseek/glm5/kimi/llama4/mistral/gemma4).
const SUPPORTED_MODELS: { id: string; label: string }[] = [
  { id: "Qwen/Qwen2.5-7B-Instruct", label: "Qwen2.5 7B Instruct" },
  { id: "Qwen/Qwen2.5-32B-Instruct", label: "Qwen2.5 32B Instruct" },
  { id: "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B", label: "DeepSeek R1 (Distill 32B)" },
  { id: "zai-org/GLM-5", label: "GLM-5" },
  { id: "moonshotai/Kimi-K2-Instruct", label: "Kimi K2" },
  { id: "meta-llama/Llama-4-Scout-17B-16E-Instruct", label: "Llama 4 Scout" },
  { id: "mistralai/Mistral-Nemo-Instruct-2407", label: "Mistral Nemo" },
  { id: "google/Gemma-4-9b-it", label: "Gemma 4 9B" },
];

export default function Home() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [modal, setModal] = useState(false);
  const [detail, setDetail] = useState<Provider | null>(null);
  const [network, setNetwork] = useState("testnet");
  const [refreshing, setRefreshing] = useState(false);
  // Use the wallet's active address. If it's not on the gateway's network the
  // user must switch their wallet's network (we don't silently derive one).
  const addresses = useWalletAddresses();
  const wallet = addresses[0] ?? null;
  const walletNet = addressNetwork(wallet);
  const netMismatch = !!wallet && !!walletNet && walletNet !== network;
  const onConnect = useCallback(async () => {
    try {
      // Immediate, unmistakable feedback if they connected the wrong network.
      const addr = (await connectWallet())[0] ?? null;
      const net = addressNetwork(addr);
      if (addr && net && net !== network) {
        toast.error(`Your wallet is on ${net} — switch it to ${network} to register or manage endpoints.`);
      } else if (addr) {
        toast.success(`Connected ${addr.slice(0, 6)}…${addr.slice(-4)}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("wallet connect failed:", e);
      // Ignore the user simply closing the picker; surface everything else.
      if (!/cancel|reject|closed|denied/i.test(msg)) {
        toast.error(msg || "Couldn't open a wallet. Is a Stacks wallet (Leather/Xverse) installed?");
      }
    }
  }, [network]);
  const onDisconnect = useCallback(() => { disconnectWallet(); }, []);

  // Register always opens the modal; the modal itself gates on wallet connection.
  const openRegister = useCallback(() => setModal(true), []);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch(`${GATEWAY}/v1/providers`);
      const d = await r.json();
      setProviders(d.data || []);
    } catch { /* offline */ }
    finally { setRefreshing(false); }
  }, []);

  // Network (testnet/mainnet) comes from the gateway so the badge can never
  // drift from what the gateway is actually settling on.
  useEffect(() => {
    fetch(`${GATEWAY}/health`)
      .then((r) => r.json())
      .then((d) => { if (d?.network) setNetwork(String(d.network)); })
      .catch(() => { /* keep default */ });
  }, []);

  // Fetch once on page load so every visitor sees current status. No polling —
  // status only changes on the gateway's 5-min health cron; use Refresh for a
  // manual update.
  useEffect(() => { load(); }, [load]);

  // keep the open detail panel fresh
  useEffect(() => {
    if (!detail) return;
    const updated = providers.find((p) => p.id === detail.id);
    if (updated && updated !== detail) setDetail(updated);
  }, [providers, detail]);

  const stats = useMemo(() => {
    const models = new Set<string>();
    providers.forEach((p) => p.models.forEach((m) => models.add(m.id)));
    return { total: providers.length, live: providers.filter((p) => p.status === "live").length, models: models.size };
  }, [providers]);

  // Live providers float to the top; down ones sink to the bottom. Within a
  // status group the gateway's order (registered_at) is preserved by the stable
  // sort, so the list only reshuffles when a provider's health changes.
  const sorted = useMemo(() => {
    const rank: Record<string, number> = { live: 0, degraded: 1, pending: 2, down: 3 };
    return [...providers].sort((a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2));
  }, [providers]);

  return (
    <div className="min-h-screen overflow-x-hidden">
      <Toaster position="top-center" theme="dark" richColors />
      <header className="sticky top-0 z-20 border-b border-[#23262d] bg-[#08090a]/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-3 sm:px-5 sm:py-3.5">
          <div className="flex items-center gap-2 sm:gap-2.5">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-[#f7931a] text-[15px] font-bold text-[#1a1206]">⚡</span>
            <span className="wide hidden whitespace-nowrap text-[15px] font-medium tracking-tight sm:inline">Inference Marketplace</span>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            {(() => {
              const isMain = network === "mainnet";
              return (
                <span
                  title={isMain
                    ? "This marketplace runs on Stacks mainnet — endpoints and payments settle in real sBTC."
                    : `This marketplace runs on Stacks ${network} — endpoints and payments settle in ${network} sBTC.`}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider ${isMain ? "border-[#123a1c] bg-[#06140b] text-[#35c759]" : "border-[#3a2f12] bg-[#1a1206] text-[#f7931a]"}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${isMain ? "bg-[#35c759]" : "bg-[#f7931a]"}`} />
                  {network}
                </span>
              );
            })()}
            {wallet && (
              <Link href="/dashboard" className="hidden shrink-0 rounded-lg border border-[#23262d] bg-[#101216] px-3 py-2 text-[12px] text-[#9aa3af] transition-colors hover:text-[#f2f4f7] sm:inline-block">
                Dashboard
              </Link>
            )}
            {wallet && (
              <button onClick={onDisconnect} title={`Connected: ${wallet}\nTap to disconnect`} className="mono shrink-0 rounded-lg border border-[#23262d] bg-[#101216] px-3 py-2 text-[12px] text-[#9aa3af] transition-colors hover:text-[#f2f4f7]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#35c759] inline-block mr-1.5 align-middle" />
                {trunc(wallet)}
              </button>
            )}
            <button onClick={openRegister} className="shrink-0 rounded-lg bg-[#f7931a] px-3 py-2 text-[13px] font-medium text-[#1a1206] transition-opacity hover:opacity-90 sm:px-4">
              <span className="sm:hidden">Register</span>
              <span className="hidden sm:inline">Register endpoint</span>
            </button>
          </div>
        </div>
      </header>

      {netMismatch && (
        <div className="border-b border-[#ffbf2e]/30 bg-[#ffbf2e]/[0.08] px-5 py-2.5 text-center text-xs text-[#ffce6b]">
          Your wallet is on <b>{walletNet}</b>, but this marketplace runs on <b>{network}</b>. Switch your wallet&apos;s network to {network} to register or manage endpoints.
        </div>
      )}

      <section className="relative overflow-hidden border-b border-[#23262d]">
        <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 h-[420px] w-[820px] -translate-x-1/2" style={{ background: "radial-gradient(closest-side, rgba(247,147,26,0.16), transparent)" }} />
        <div className="relative mx-auto max-w-6xl px-5 py-12">
          <h1 className="wide max-w-3xl text-3xl leading-[1.08] tracking-tight md:text-5xl">
            Get paid in <span className="text-[#f7931a]">Bitcoin</span> to run open models.
          </h1>
          <p className="mt-4 max-w-xl text-[15px] text-[#9aa3af]">
            One command turns your machine into a paid inference endpoint. You keep <span className="text-[#f2f4f7]">100%</span>, paid per request in sBTC or USDCx — no account, no gatekeeping.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            {[{ n: stats.total, l: "providers" }, { n: stats.live, l: "live now", accent: true }, { n: stats.models, l: "models" }].map((s) => (
              <div key={s.l} className="rounded-xl border border-[#23262d] bg-[#101216] px-5 py-2.5">
                <div className="wide text-xl tabular-nums" style={s.accent ? { color: "#35c759" } : undefined}>{s.n}</div>
                <div className="text-xs uppercase tracking-wider text-[#9aa3af]">{s.l}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <main className="mx-auto max-w-6xl px-5 py-10">
        {wallet && (
          <div className="mb-6 flex items-center justify-between rounded-xl border border-[#f7931a]/25 bg-[#f7931a]/[0.04] px-4 py-3">
            <p className="text-sm text-[#cfd5dd]">Manage the endpoints paid to your wallet.</p>
            <Link href="/dashboard" className="shrink-0 rounded-lg border border-[#f7931a]/40 bg-[#f7931a]/10 px-3 py-1.5 text-xs font-medium text-[#f7931a] hover:bg-[#f7931a]/15">Open dashboard →</Link>
          </div>
        )}
        <ProviderList providers={sorted} refreshing={refreshing} onRefresh={load} onOpen={setDetail} onRegister={openRegister} />
      </main>

      <footer className="border-t border-[#23262d]">
        <div className="mx-auto max-w-6xl px-5 py-6 text-xs text-[#9aa3af]">Non-custodial · clients pay providers directly via x402 · settled in sBTC on Stacks.</div>
      </footer>

      {modal && <RegisterModal onClose={() => setModal(false)} onDone={load} network={network} wallet={wallet} onConnect={onConnect} />}
      {detail && <ProviderDetail provider={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

// What each status means, per the gateway's health check (GET {endpoint}/models
// every 5 min; see src/health.ts).
const STATUS_HINT: Record<string, string> = {
  live: "Answered the last health check in under 4s",
  degraded: "Answered the last health check, but slowly (4–8s)",
  down: "Didn't answer the last health check",
  pending: "Not checked yet",
};
const hostOf = (endpoint: string) => { try { return new URL(endpoint).host; } catch { return endpoint; } };
const shortModel = (id: string) => id.split("/").pop() ?? id;

type Filter = "all" | "live" | "degraded" | "down";

function ProviderList({ providers, refreshing, onRefresh, onOpen, onRegister }: {
  providers: Provider[]; refreshing: boolean; onRefresh: () => void; onOpen: (p: Provider) => void; onRegister: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [showOffline, setShowOffline] = useState(false);

  const q = query.trim().toLowerCase();
  const matches = (p: Provider) => !q
    || p.name.toLowerCase().includes(q)
    || p.endpoint.toLowerCase().includes(q)
    || p.payoutAddress.toLowerCase().includes(q)
    || p.models.some((m) => m.id.toLowerCase().includes(q));
  const searched = providers.filter(matches);
  const counts: Record<Filter, number> = {
    all: searched.length,
    live: searched.filter((p) => p.status === "live").length,
    degraded: searched.filter((p) => p.status === "degraded").length,
    down: searched.filter((p) => p.status === "down").length,
  };
  const visible = filter === "all" ? searched : searched.filter((p) => p.status === filter);
  // In "All", offline providers are folded away so working ones lead the list.
  const online = filter === "all" ? visible.filter((p) => p.status !== "down") : visible;
  const offline = filter === "all" ? visible.filter((p) => p.status === "down") : [];

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-medium">Providers</h2>
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#23262d] bg-[#101216] px-3 py-1.5 text-xs text-[#9aa3af] transition-colors hover:text-[#f2f4f7] disabled:opacity-60"
        >
          <span className={refreshing ? "inline-block h-3 w-3 animate-spin rounded-full border-2 border-[#f7931a] border-t-transparent" : ""}>{refreshing ? "" : "↻"}</span>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {providers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[#23262d] bg-[#101216] p-12 text-center">
          <p className="text-[#9aa3af]">No providers yet.</p>
          <button onClick={onRegister} className="mt-2 text-sm font-medium text-[#f7931a] hover:opacity-90">Register the first endpoint →</button>
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-1 overflow-x-auto rounded-lg border border-[#23262d] bg-[#0b0d10] p-1 text-xs">
              {(["all", "live", "degraded", "down"] as const).map((f) => {
                const c = f === "all" ? undefined : STATUS[f].c;
                return (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    title={f === "all" ? undefined : STATUS_HINT[f]}
                    className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 capitalize ${filter === f ? "bg-[#15181d] text-[#f2f4f7]" : "text-[#9aa3af] hover:text-[#cfd5dd]"}`}
                  >
                    {c && <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />}
                    {f}
                    <span className="tabular-nums text-[#5b626c]">{counts[f]}</span>
                  </button>
                );
              })}
            </div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, model, wallet…"
              className="w-full rounded-lg border border-[#23262d] bg-[#0b0d10] px-3 py-2 text-sm outline-none placeholder:text-[#5b626c] focus:border-[#f7931a] sm:w-64"
            />
          </div>

          {online.length === 0 && offline.length === 0 && (
            <p className="rounded-xl border border-dashed border-[#23262d] bg-[#101216] px-4 py-8 text-center text-sm text-[#9aa3af]">No providers match.</p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {online.map((p) => <ProviderCard key={p.id} p={p} onOpen={onOpen} />)}
          </div>
          {offline.length > 0 && (
            <>
              <button
                onClick={() => setShowOffline((v) => !v)}
                className="mt-4 flex items-center gap-2 text-xs text-[#9aa3af] hover:text-[#f2f4f7]"
              >
                <span>{showOffline ? "▾" : "▸"}</span>
                {showOffline ? "Hide" : "Show"} {offline.length} offline
              </button>
              {showOffline && (
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {offline.map((p) => <ProviderCard key={p.id} p={p} onOpen={onOpen} />)}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function ProviderCard({ p, onOpen }: { p: Provider; onOpen: (p: Provider) => void }) {
  const st = STATUS[p.status] ?? STATUS.pending;
  const down = p.status === "down";
  const shown = p.models.slice(0, 3);
  const rest = p.models.length - shown.length;
  const latency = down || p.health?.latencyMs == null ? "—"
    : p.health.latencyMs < 1000 ? `${p.health.latencyMs}ms` : `${(p.health.latencyMs / 1000).toFixed(1)}s`;
  return (
    <button
      onClick={() => onOpen(p)}
      className={`group flex h-full w-full min-w-0 flex-col rounded-xl border border-[#23262d] bg-[#101216] p-4 text-left transition-colors hover:border-[#f7931a]/40 hover:bg-[#121419] ${down ? "opacity-55" : ""}`}
    >
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#f7931a]/12 text-sm font-semibold text-[#f7931a]">{p.name.charAt(0).toUpperCase()}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={p.name}>{p.name}</div>
          <div className="mono truncate text-[11px] text-[#5b626c]" title={p.endpoint}>{hostOf(p.endpoint)}</div>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-[#23262d] bg-[#15181d] px-2 py-0.5 text-[11px]" title={STATUS_HINT[p.status]}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: st.c }} />
          <span style={{ color: st.c }}>{st.label}</span>
        </span>
      </div>

      <div className="mb-3 mt-3 flex flex-wrap items-center gap-1" title={p.models.map((m) => m.id).join("\n")}>
        {shown.map((m) => (
          <span key={m.id} className="max-w-full truncate rounded-md border border-[#23262d] bg-[#0b0d10] px-1.5 py-0.5 text-[11px] text-[#cfd5dd]">{shortModel(m.id)}</span>
        ))}
        {rest > 0 && <span className="px-1 text-[11px] text-[#9aa3af]">+{rest} more</span>}
      </div>

      {/* pinned to the bottom so cards in a row line up regardless of model count */}
      <div className="mt-auto grid grid-cols-3 gap-2 border-t border-[#23262d] pt-3 text-[11px]">
        <div>
          <div className="text-[#5b626c]">Per request</div>
          <div className={`tabular-nums ${p.pricePerRequest ? "text-[#cfd5dd]" : "text-[#5b626c]"}`}>{formatPrice(p.pricePerRequest, p.acceptedToken)}</div>
        </div>
        <div>
          <div className="text-[#5b626c]">Latency</div>
          <div className="tabular-nums text-[#cfd5dd]">{latency}</div>
        </div>
        <div className="min-w-0">
          <div className="text-[#5b626c]">Paid to</div>
          <div className="mono truncate text-[#cfd5dd]" title={p.payoutAddress}>{trunc(p.payoutAddress)}</div>
        </div>
      </div>
    </button>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200); }}
      className="rounded-md border border-[#23262d] px-2 py-1 text-xs text-[#9aa3af] transition-colors hover:border-[#f7931a] hover:text-[#f7931a]"
    >
      {done ? "copied ✓" : "copy"}
    </button>
  );
}

function ProviderDetail({ provider: p, onClose }: { provider: Provider; onClose: () => void }) {
  useEscape(onClose);
  // Recheck this provider the moment the drawer opens, so the status shown is
  // current rather than up-to-5-min stale from the cron. Falls back to the
  // last-known status if the probe fails.
  const [prov, setProv] = useState(p);
  const [rechecking, setRechecking] = useState(false);
  const st = STATUS[prov.status] ?? STATUS.pending;
  const modelId = p.models[0]?.id ?? "";
  const [prompt, setPrompt] = useState("In one sentence, what is Bitcoin?");
  const [running, setRunning] = useState(false);
  const [out, setOut] = useState<{ content?: string; latencyMs?: number; error?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRechecking(true);
    fetch(`${GATEWAY}/v1/providers/${p.id}/check`, { method: "POST" })
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d?.provider) setProv(d.provider); })
      .catch(() => { /* keep last-known status */ })
      .finally(() => { if (!cancelled) setRechecking(false); });
    return () => { cancelled = true; };
  }, [p.id]);

  async function run() {
    setRunning(true); setOut(null);
    try {
      const r = await fetch(`${GATEWAY}/v1/providers/${p.id}/test`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }),
      });
      setOut(await r.json());
    } catch (e) { setOut({ error: String(e) }); }
    finally { setRunning(false); }
  }

  const routeUrl = `${GATEWAY}/v1/route/${p.id}/chat/completions`;
  const mcp = `execute_x402_endpoint({\n  url: "${routeUrl}",\n  method: "POST",\n  data: {\n    model: "${modelId}",\n    messages: [{ role: "user", content: ${JSON.stringify(prompt)} }]\n  }\n})`;
  const curl = `curl -X POST ${routeUrl} \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify({ model: modelId, messages: [{ role: "user", content: prompt }] })}'`;

  return (
    <div className="overlay-in fixed inset-0 z-50 bg-black/65 backdrop-blur-sm" onClick={onClose}>
      <aside
        className="drawer-in fixed inset-y-0 right-0 flex w-full max-w-xl flex-col border-l border-[#23262d] bg-[#0c0e12] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label={`${p.name} details`}
      >
        {/* sticky header stays put while the body scrolls */}
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-[#23262d] bg-[#0c0e12]/95 px-6 py-4 backdrop-blur">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-[#f7931a]/12 text-base font-semibold text-[#f7931a]">{p.name.charAt(0).toUpperCase()}</span>
            <div>
              <h2 className="wide text-lg leading-tight">{p.name}</h2>
              <span className="flex items-center gap-1.5 text-xs">
                <span className="h-2 w-2 rounded-full" style={{ background: st.c }} />
                <span style={{ color: st.c }}>{st.label}</span>
                {prov.health?.latencyMs != null && <span className="text-[#9aa3af]">· {prov.health.latencyMs}ms</span>}
                {prov.health?.x402 && <span className="text-[#9aa3af]">· x402</span>}
                {rechecking && <span className="flex items-center gap-1 text-[#5b626c]"><span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-[#5b626c] border-t-transparent" />rechecking…</span>}
              </span>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-[#9aa3af] hover:bg-[#15181d] hover:text-[#f2f4f7]">✕</button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {p.description && <p className="text-sm text-[#cfd5dd]">{p.description}</p>}

          <div className="mt-4 grid gap-2 text-xs text-[#9aa3af]">
            <div>endpoint <span className="mono break-all text-[#cfd5dd]">{p.endpoint}</span></div>
            <div>pays to <span className="mono break-all text-[#cfd5dd]">{p.payoutAddress}</span> <span className="text-[#5b626c]">in</span> <span className="text-[#cfd5dd]">{p.acceptedToken ?? "sBTC"}</span></div>
          </div>

          {/* signature: fee-free — 100% to the provider, shown as a full bar */}
          <div className="mt-5 rounded-xl border border-[#23262d] bg-[#101216] p-4">
            <div className="flex items-baseline justify-between">
              <h3 className="text-xs uppercase tracking-wider text-[#9aa3af]">Per request</h3>
              <span className="wide text-base text-[#f7931a]">{formatPrice(p.pricePerRequest, p.acceptedToken)}</span>
            </div>
            <div className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-full">
              <div className="h-full rounded-full bg-[#f7931a]" style={{ width: "100%" }} />
            </div>
            <div className="mt-3 text-xs">
              <div className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#f7931a]" /><span className="text-[#f2f4f7]">100% · provider</span></div>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-[#5b626c]">A flat price the provider set — every call pays exactly this, whatever its length. Settled on-chain and non-custodial, directly to the provider through our x402 wrapper.</p>
          </div>

          {/* model capabilities */}
          <h3 className="mt-6 mb-2 text-xs uppercase tracking-wider text-[#9aa3af]">Models</h3>
          <div className="space-y-2">
            {p.models.map((m) => (
              <div key={m.id} className="rounded-lg border border-[#23262d] bg-[#15181d] p-3">
                <div className="flex items-center justify-between">
                  <span className="mono text-sm text-[#f2f4f7]">{m.id}</span>
                  {m.contextLength && <span className="text-xs text-[#9aa3af]">{m.contextLength.toLocaleString()} ctx</span>}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {(m.capabilities ?? []).map((c) => (
                    <span key={c} className="rounded-md border border-[#23262d] bg-[#0b0d10] px-2 py-0.5 text-xs text-[#7da2ff]">{c}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* test console */}
          <h3 className="mt-6 mb-2 text-xs uppercase tracking-wider text-[#9aa3af]">Test it · free preview (no payment)</h3>
          <div className="rounded-lg border border-[#23262d] bg-[#0b0d10] p-3">
            <textarea
              value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2}
              className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-[#5b626c]"
              placeholder="Ask the model something…"
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="mono text-xs text-[#5b626c]">{modelId}</span>
              <button onClick={run} disabled={running || prov.status === "down"} className="rounded-lg bg-[#f7931a] px-4 py-1.5 text-sm font-medium text-[#1a1206] transition-opacity hover:opacity-90 disabled:opacity-50">
                {running ? "Running…" : "Run"}
              </button>
            </div>
            {out && (
              <div className="mt-3 rounded-md border border-[#23262d] bg-[#101216] p-3 text-sm">
                {out.error ? <span className="text-[#ff4d4f]">{out.error}</span> : (
                  <>
                    <div className="whitespace-pre-wrap text-[#e7eaee]">{out.content}</div>
                    {out.latencyMs != null && <div className="mt-2 text-xs text-[#9aa3af]">{out.latencyMs}ms</div>}
                  </>
                )}
              </div>
            )}
          </div>

          {/* how an agent calls it */}
          <h3 className="mt-6 mb-2 text-xs uppercase tracking-wider text-[#9aa3af]">Use it · paid via x402</h3>
          <div className="space-y-3">
            <Snippet label="AIBTC MCP — pays the provider through our x402 wrapper" code={mcp} />
            <Snippet label="curl (returns a 402 with the price until paid)" code={curl} />
          </div>
        </div>
      </aside>
    </div>
  );
}

function Snippet({ label, code }: { label: string; code: string }) {
  return (
    <div className="rounded-lg border border-[#23262d] bg-[#0b0d10]">
      <div className="flex items-center justify-between border-b border-[#23262d] px-3 py-1.5">
        <span className="text-xs text-[#9aa3af]">{label}</span>
        <Copy text={code} />
      </div>
      <pre className="mono overflow-x-auto p-3 text-xs leading-relaxed text-[#cfd5dd]">{code}</pre>
    </div>
  );
}

// Read-only payout = the connected wallet. Earnings settle here; not editable.
function PayoutField({ payout }: { payout: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs text-[#9aa3af]">Payout wallet (your connected wallet)</span>
      <div className="mono flex items-center gap-2 break-all rounded-lg border border-[#23262d] bg-[#0b0d10] px-3 py-2.5 text-xs text-[#cfd5dd]">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#35c759]" />
        {payout || "—"}
      </div>
    </label>
  );
}

function RegisterModal({ onClose, onDone, network, wallet, onConnect }: { onClose: () => void; onDone: () => void; network: string; wallet: string | null; onConnect: () => void }) {
  useEscape(onClose);
  // Payout is always the connected wallet.
  const payout = (wallet ?? "").trim();
  // Gate the form until a wallet on the right network is connected.
  const walletNet = addressNetwork(wallet);
  const needsConnect = !wallet;
  const wrongNet = !!wallet && walletNet !== network;
  const gated = needsConnect || wrongNet;
  const [tab, setTab] = useState<"local" | "public">("public");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [watching, setWatching] = useState(false);

  const [lf, setLf] = useState({ name: "", models: "", port: "11434", host: "" });
  const [src, setSrc] = useState("");
  const [pubKey, setPubKey] = useState("");
  // Inline fields for an already-public endpoint (skipped when a schema.json URL
  // is pasted — the manifest carries name/wallet/models itself).
  const [pf, setPf] = useState({ name: "", models: "" });
  // Token this provider is paid in (applies to both tabs). Client pays in it.
  const [payToken, setPayToken] = useState<PayToken>("sBTC");
  // Flat price per request, typed in the token's unit (sats, or USDCx).
  const [price, setPrice] = useState("");
  const priceBase = priceToBaseUnits(price, payToken);

  // After the user runs the connect command on their machine, the script
  // registers itself — so we poll the directory and confirm the moment the
  // node shows up (matched by wallet + display name).
  useEffect(() => {
    if (!watching) return;
    let alive = true;
    const want = { name: lf.name.trim(), wallet: payout };
    const tick = async () => {
      try {
        const r = await fetch(`${GATEWAY}/v1/providers`);
        const j = await r.json();
        const me = (j.data as Provider[] | undefined)?.find(
          (p) => p.payoutAddress === want.wallet && p.name.trim() === want.name
        );
        if (me && alive) {
          setWatching(false);
          setResult({ ok: true, msg: "Detected ✓ your node is live in the directory." });
          onDone();
          setTimeout(onClose, 2000);
          return;
        }
      } catch { /* keep polling */ }
      if (alive) setTimeout(tick, 4000);
    };
    tick();
    return () => { alive = false; };
  }, [watching, lf.name, payout, onDone, onClose]);

  async function sendPublic(payload: Record<string, unknown>) {
    setBusy(true); setResult(null);
    try {
      // Prove ownership: sign the register message with the payout wallet. The
      // gateway only stores the endpoint if the signature recovers to payoutAddress.
      // Scope must match the server's (the endpoint URL, or manifestUrl).
      const scope = String(payload.endpoint || payload.manifestUrl || "");
      const headers = await signAuthHeaders("register", scope);
      const r = await fetch(`${GATEWAY}/v1/providers`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const j = await r.json();
      if (r.ok) { setResult({ ok: true, msg: "Verified ✓ reachable + serving inference." }); onDone(); setTimeout(onClose, 1400); }
      else setResult({ ok: false, msg: j.error || "Couldn't verify that endpoint." });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setResult({ ok: false, msg: /cancel|reject|closed|denied/i.test(msg) ? "Signature cancelled — you must sign to prove you own the payout wallet." : "Gateway unreachable." });
    }
    finally { setBusy(false); }
  }

  // A schema.json URL self-describes; a bare endpoint needs name/wallet/models
  // supplied inline. We send the inline fields verbatim — the gateway validates
  // the models against Hugging Face and verifies the endpoint before listing.
  const pubIsManifest = src.trim().endsWith(".json");
  const pubReady = !!payout && !!src.trim() && !!priceBase && (pubIsManifest || !!(pf.name.trim() && pf.models.trim()));

  function submitPublic(e: FormEvent) {
    e.preventDefault();
    const url = src.trim();
    const apiKey = pubKey.trim() || undefined;
    if (pubIsManifest) {
      sendPublic({ manifestUrl: url, payoutAddress: payout, acceptedToken: payToken, pricePerRequest: priceBase, ...(apiKey ? { apiKey } : {}) });
      return;
    }
    const models = pf.models.split(",").map((m) => m.trim()).filter(Boolean);
    sendPublic({
      name: pf.name.trim(),
      endpoint: url,
      payoutAddress: payout,
      acceptedToken: payToken,
      pricePerRequest: priceBase,
      models,
      ...(apiKey ? { apiKey } : {}),
    });
  }

  const inputCls = "w-full rounded-lg border border-[#23262d] bg-[#0b0d10] px-3 py-2.5 text-sm outline-none placeholder:text-[#5b626c] focus:border-[#f7931a]";
  const gw = typeof window !== "undefined" ? window.location.origin : GATEWAY;
  // Build commands from real values only — never leak SP.../placeholder model into
  // a paste. Normalize the model list (trim each id, drop blanks) so stray spaces
  // can't sneak in. Commands stay hidden until name + wallet + model are filled.
  const name = lf.name.trim();
  const port = lf.port.trim() || "11434";
  const models = lf.models.split(",").map((m) => m.trim()).filter(Boolean).join(",");
  const ready = !!(name && payout && models && priceBase);
  const modelId = models.split(",")[0]?.trim() || "";
  // A self-contained prompt the user pastes into Claude Code (or any AI agent with
  // the AIBTC MCP): it hosts the model, tunnels it, and registers with a wallet
  // signature — no terminal script needed.
  const agentPrompt = `List my local model on the AIBTC Inference Marketplace (${gw}) and get me paid in sBTC. Do it end-to-end:

1. Make sure Ollama is running (run "ollama serve") and pull the model matching "${modelId || "<model>"}" (use its qwen2.5 / llama Ollama tag).
2. Expose it with a Cloudflare tunnel, rewriting the Host header so Ollama accepts it:
   cloudflared tunnel --url http://localhost:${port} --http-host-header localhost:${port}
   Take the printed https://<sub>.trycloudflare.com URL — my endpoint is that URL + "/v1".
3. Register at ${gw}/v1/providers, proving ownership with my Stacks wallet:
   - Sign this message (Timestamp = current unix seconds) with stacks_sign_message:
       Inference Marketplace
       Action: register
       Provider: <endpoint>
       Timestamp: <now>
   - Get my public key and ${network} address from get_wallet_info.
   - POST with headers X-Stacks-Signature, X-Stacks-Public-Key, X-Stacks-Timestamp and body:
       {"name":"${name || "My node"}","endpoint":"<endpoint>","payoutAddress":"${payout || "<wallet>"}","acceptedToken":"${payToken}","pricePerRequest":"${priceBase ?? "<price>"}","models":["${modelId || "<model>"}"]}

Keep the tunnel running and tell me when my node shows up in the marketplace.`;

  return (
    <div className="overlay-in fixed inset-0 z-50 bg-black/65 backdrop-blur-sm" onClick={onClose}>
      <div className="drawer-in fixed inset-y-0 right-0 flex w-full max-w-xl flex-col overflow-hidden border-l border-[#23262d] bg-[#0c0e12] shadow-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="flex shrink-0 items-start justify-between border-b border-[#23262d] px-5 py-4 sm:px-6">
          <div>
            <h2 className="wide text-lg">List your model</h2>
            <p className="mt-1 text-sm text-[#9aa3af]">Get paid in sBTC for serving inference.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-[#9aa3af] hover:bg-[#15181d] hover:text-[#f2f4f7]">✕</button>
        </div>

        <div className="relative flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          {gated && (
            <div className="absolute inset-0 z-10 grid place-items-center p-6">
              <div className="max-w-xs rounded-xl border border-[#23262d] bg-[#0c0e12] p-5 text-center shadow-2xl">
                {needsConnect ? (
                  <>
                    <p className="text-sm font-medium text-[#f2f4f7]">Connect your wallet to register</p>
                    <p className="mt-1 text-xs text-[#9aa3af]">Your connected wallet becomes the payout address for this endpoint.</p>
                    <button onClick={onConnect} className="mt-3 w-full rounded-lg bg-[#f7931a] py-2.5 text-sm font-medium text-[#1a1206] hover:opacity-90">Connect wallet</button>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium text-[#ffbf2e]">Wrong network</p>
                    <p className="mt-1 text-xs text-[#9aa3af]">Your wallet is on {walletNet}. Switch it to {network} to register.</p>
                  </>
                )}
              </div>
            </div>
          )}
          <div className={`w-full ${gated ? "pointer-events-none select-none blur-[3px] opacity-40" : ""}`}>
        <div className="flex gap-1 rounded-lg border border-[#23262d] bg-[#0b0d10] p-1 text-sm">
          {(["public", "local"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`flex-1 rounded-md py-1.5 ${tab === t ? "bg-[#15181d] text-[#f2f4f7]" : "text-[#9aa3af]"}`}>
              {t === "public" ? "Public endpoint" : "Running locally"}
            </button>
          ))}
        </div>

        <p className="mt-3 rounded-md border border-[#35c759]/25 bg-[#35c759]/[0.06] px-2.5 py-2 text-[11px] leading-relaxed text-[#9aa3af]">
          <span className="text-[#f2f4f7]">Fee:</span> each paid request settles on-chain, non-custodial — <span className="text-[#35c759]">100% goes straight to your payout wallet</span>. No listing fee, no fee to join.
        </p>

        <label className="mt-3 block">
          <span className="mb-1.5 block text-xs text-[#9aa3af]">Get paid in</span>
          <select value={payToken} onChange={(e) => setPayToken(e.target.value as PayToken)} className={inputCls}>
            <option value="sBTC">sBTC</option>
            <option value="USDCx">USDCx</option>
          </select>
        </label>

        <label className="mt-3 block">
          <span className="mb-1.5 block text-xs text-[#9aa3af]">Price per request</span>
          <PriceInput value={price} token={payToken} onChange={setPrice} className={inputCls} />
          <span className="mt-1 block text-[11px] text-[#5b626c]">
            {priceBase ? `Every call pays you exactly ${formatPrice(priceBase, payToken)}.` : `Required — ${payToken === "sBTC" ? "whole sats" : "USDCx, up to 6 decimals"}. x402 charges one flat amount per request.`}
          </span>
        </label>

        {tab === "local" ? (
          <div className="mt-4">
            <p className="mb-3 text-xs text-[#9aa3af]"><span className="text-[#f2f4f7]">Step 1.</span> Your node details (these fill the prompt below):</p>
            <label className="mb-3 block">
              <span className="mb-1.5 block text-xs text-[#9aa3af]">Display name</span>
              <input value={lf.name} onChange={(e) => setLf({ ...lf, name: e.target.value })} placeholder="Alice's Qwen node" className={inputCls} />
            </label>
            <PayoutField payout={payout} />
            <label className="mb-3 block">
              <span className="mb-1.5 block text-xs text-[#9aa3af]">Supported model</span>
              <select value={lf.models} onChange={(e) => setLf({ ...lf, models: e.target.value })} className={inputCls}>
                <option value="">Select a model…</option>
                {SUPPORTED_MODELS.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
              </select>
            </label>
            <label className="mb-3 block">
              <span className="mb-1.5 block text-xs text-[#9aa3af]">Local model port</span>
              <input value={lf.port} onChange={(e) => setLf({ ...lf, port: e.target.value })} placeholder="11434" className={inputCls} />
            </label>
            <p className="mb-2 mt-1 text-xs text-[#9aa3af]"><span className="text-[#f2f4f7]">Step 2.</span> Paste this into <span className="text-[#f2f4f7]">Claude Code</span> (or any AI agent with the AIBTC MCP). It hosts your model, opens a tunnel, and registers it with your wallet signature — no script to run:</p>
            {ready ? (
              <Snippet label="copy → paste into your AI agent" code={agentPrompt} />
            ) : (
              <div className="rounded-lg border border-dashed border-[#2a2e36] bg-[#0b0d10] px-3 py-3 text-xs text-[#5b626c]">Fill name, wallet, model &amp; price above — your prompt appears here.</div>
            )}
            <p className="mt-1.5 rounded-md border border-[#35c759]/25 bg-[#35c759]/[0.06] px-2.5 py-2 text-[11px] text-[#9aa3af]">
              No wallet keys leave your machine — the agent signs locally with your wallet. No model yet? The agent pulls one for you.
            </p>

            <div className="mt-5 border-t border-[#23262d] pt-4">
              <p className="mb-2 text-xs text-[#9aa3af]"><span className="text-[#f2f4f7]">Step 3.</span> Once the agent registers it, keep the tunnel running — then watch for your node to appear:</p>
              {watching ? (
                <button onClick={() => setWatching(false)} className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#23262d] bg-[#0b0d10] py-3 text-sm text-[#9aa3af] hover:text-[#f2f4f7]">
                  <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#f7931a] border-t-transparent" />
                  Watching for your node… (cancel)
                </button>
              ) : (
                <button
                  onClick={() => { setResult(null); setWatching(true); }}
                  disabled={!lf.name.trim() || !payout}
                  className="w-full rounded-lg bg-[#f7931a] py-3 text-sm font-medium text-[#1a1206] transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  I&apos;ve run it — watch for my node
                </button>
              )}
              {!lf.name.trim() ? (
                <p className="mt-1.5 text-[11px] text-[#5b626c]">Fill in a display name above so we can match your node.</p>
              ) : null}
            </div>
          </div>
        ) : (
          <form onSubmit={submitPublic} className="mt-4">
            <label className="block">
              <span className="mb-1.5 block text-xs text-[#9aa3af]">Public endpoint or schema.json URL</span>
              <input required value={src} onChange={(e) => setSrc(e.target.value)} placeholder="https://your-host/v1" className={inputCls} />
            </label>

            {pubIsManifest ? (
              <p className="mt-2 rounded-md border border-[#23262d] bg-[#0b0d10] px-2.5 py-2 text-[11px] text-[#9aa3af]">
                We&apos;ll read name, wallet &amp; models from your <span className="mono text-[#cfd5dd]">schema.json</span>.
              </p>
            ) : (
              <>
                <label className="mt-3 block">
                  <span className="mb-1.5 block text-xs text-[#9aa3af]">Display name</span>
                  <input value={pf.name} onChange={(e) => setPf({ ...pf, name: e.target.value })} placeholder="Alice's Qwen node" className={inputCls} />
                </label>
                <div className="mt-3"><PayoutField payout={payout} /></div>
                <label className="mt-3 block">
                  <span className="mb-1.5 block text-xs text-[#9aa3af]">Supported model</span>
                  <select value={pf.models} onChange={(e) => setPf({ ...pf, models: e.target.value })} className={inputCls}>
                    <option value="">Select a model…</option>
                    {SUPPORTED_MODELS.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
                  </select>
                </label>
              </>
            )}

            <label className="mt-3 block">
              <span className="mb-1.5 block text-xs text-[#9aa3af]">API key (optional — if your endpoint requires one)</span>
              <input value={pubKey} onChange={(e) => setPubKey(e.target.value)} placeholder="leave blank if open" className={inputCls} />
            </label>
            <p className="mt-2 text-xs text-[#9aa3af]">Paste your endpoint — we verify it&apos;s reachable + serving inference, then list it and wrap it in x402.</p>
            <button disabled={busy || !pubReady} className="mt-4 w-full rounded-lg bg-[#f7931a] py-3 text-sm font-medium text-[#1a1206] transition-opacity hover:opacity-90 disabled:opacity-60">{busy ? "Verifying…" : "Register & verify"}</button>
          </form>
        )}

        {result && (
          <div className="mt-3.5 rounded-lg border px-3 py-2.5 text-sm" style={result.ok ? { borderColor: "rgba(53,199,89,.4)", background: "rgba(53,199,89,.08)" } : { borderColor: "rgba(255,77,79,.4)", background: "rgba(255,77,79,.08)" }}>
            {result.msg}
          </div>
        )}
          </div>
        </div>
      </div>
    </div>
  );
}
