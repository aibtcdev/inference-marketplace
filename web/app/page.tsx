"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Same-origin in production (the Worker serves both UI and API); override via
// NEXT_PUBLIC_GATEWAY_URL for split local dev (next dev + wrangler dev).
const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "";

type Health = { status: string; latencyMs: number; x402: boolean; checkedAt: string; error?: string } | null;
type ModelSpec = { id: string; name?: string; contextLength?: number; capabilities?: string[]; pricePerMTokenUsd?: number };
type Provider = {
  id: string;
  name: string;
  endpoint: string;
  api: string;
  payoutAddress: string;
  models: ModelSpec[];
  description?: string;
  status: "live" | "degraded" | "down" | "pending";
  health: Health;
};

const STATUS: Record<string, { c: string; label: string }> = {
  live: { c: "#35c759", label: "live" },
  degraded: { c: "#ffbf2e", label: "degraded" },
  down: { c: "#ff4d4f", label: "down" },
  pending: { c: "#6b7280", label: "checking" },
};
const trunc = (a: string) => (a && a.length > 16 ? `${a.slice(0, 9)}…${a.slice(-5)}` : a);
// x402 amounts are in BASE UNITS (sBTC: 1 = 1 sat = 1e-8 BTC; USDCx/STX: 1e-6).
function formatPrice(amount: string, asset: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${asset}`;
  if (/sbtc/i.test(asset)) return `${n.toLocaleString()} sat${n === 1 ? "" : "s"}`;
  if (/usdcx/i.test(asset)) return `${(n / 1e6).toFixed(6)} USDCx`;
  if (asset === "STX") return `${(n / 1e6).toFixed(6)} STX`;
  return `${amount} ${asset}`;
}

export default function Home() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [modal, setModal] = useState(false);
  const [detail, setDetail] = useState<Provider | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${GATEWAY}/v1/providers`);
      const d = await r.json();
      setProviders(d.data || []);
    } catch { /* offline */ }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

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

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-[#23262d] bg-[#08090a]/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-[#f7931a] text-[15px] font-bold text-[#1a1206]">⚡</span>
            <span className="wide text-[15px] font-medium tracking-tight">Inference Marketplace</span>
          </div>
          <button onClick={() => setModal(true)} className="rounded-lg bg-[#f7931a] px-4 py-2 text-[13px] font-medium text-[#1a1206] transition-opacity hover:opacity-90">
            Register endpoint
          </button>
        </div>
      </header>

      <section className="relative overflow-hidden border-b border-[#23262d]">
        <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 h-[420px] w-[820px] -translate-x-1/2" style={{ background: "radial-gradient(closest-side, rgba(247,147,26,0.16), transparent)" }} />
        <div className="relative mx-auto max-w-6xl px-5 py-12">
          <h1 className="wide max-w-3xl text-3xl leading-[1.08] tracking-tight md:text-5xl">
            Inference, settled in <span className="text-[#f7931a]">Bitcoin</span>.
          </h1>
          <p className="mt-4 max-w-xl text-[15px] text-[#9aa3af]">
            Open-model providers, verified live and paid per request in sBTC. Browse the network, inspect a model&apos;s
            capabilities, and test it — or list your own endpoint.
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
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Providers</h2>
          <span className="text-xs text-[#9aa3af]">auto-refreshes every 20s</span>
        </div>

        {providers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#23262d] bg-[#101216] p-12 text-center">
            <p className="text-[#9aa3af]">No providers yet.</p>
            <button onClick={() => setModal(true)} className="mt-2 text-sm font-medium text-[#f7931a] hover:opacity-90">Register the first endpoint →</button>
          </div>
        ) : (
          <div className="space-y-3">
            {providers.map((p) => {
              const st = STATUS[p.status] ?? STATUS.pending;
              return (
                <button key={p.id} onClick={() => setDetail(p)} className="block w-full rounded-xl border border-[#23262d] bg-[#101216] p-4 text-left transition-colors hover:border-[#33373f]">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="grid h-9 w-9 place-items-center rounded-lg bg-[#f7931a]/12 text-sm font-semibold text-[#f7931a]">{p.name.charAt(0).toUpperCase()}</span>
                      <div>
                        <div className="font-medium">{p.name}</div>
                        <div className="mono mt-0.5 break-all text-xs text-[#9aa3af]">{p.endpoint}</div>
                      </div>
                    </div>
                    <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-[#23262d] bg-[#15181d] px-2.5 py-1 text-xs">
                      <span className="h-2 w-2 rounded-full" style={{ background: st.c }} />
                      <span style={{ color: st.c }}>{st.label}</span>
                      {p.health?.latencyMs != null && p.status !== "down" && <span className="text-[#9aa3af]">· {p.health.latencyMs}ms</span>}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {p.models.map((m) => (
                      <span key={m.id} className="rounded-md border border-[#23262d] bg-[#15181d] px-2 py-0.5 text-xs text-[#cfd5dd]">{m.id}</span>
                    ))}
                  </div>
                  <div className="mt-3 text-xs text-[#9aa3af]">pays to <span className="mono text-[#cfd5dd]">{trunc(p.payoutAddress)}</span> · tap to inspect &amp; test →</div>
                </button>
              );
            })}
          </div>
        )}
      </main>

      <footer className="border-t border-[#23262d]">
        <div className="mx-auto max-w-6xl px-5 py-6 text-xs text-[#9aa3af]">Non-custodial · clients pay providers directly via x402 · settled in sBTC on Stacks.</div>
      </footer>

      {modal && <RegisterModal onClose={() => setModal(false)} onDone={load} />}
      {detail && <ProviderDetail provider={detail} onClose={() => setDetail(null)} />}
    </div>
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
  const st = STATUS[p.status] ?? STATUS.pending;
  const modelId = p.models[0]?.id ?? "";
  const [prompt, setPrompt] = useState("In one sentence, what is Bitcoin?");
  const [running, setRunning] = useState(false);
  const [out, setOut] = useState<{ content?: string; latencyMs?: number; error?: string } | null>(null);

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

  // Probe our wrapped route's 402 to show the real price clients pay.
  const [quote, setQuote] = useState<{ amount: string; asset: string; payTo: string } | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${GATEWAY}/v1/route/${p.id}/chat/completions`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 256 }),
        });
        if (r.status === 402) { const d = await r.json(); const a = d.accepts?.[0]; if (a) setQuote({ amount: a.amount, asset: a.asset, payTo: a.payTo }); }
      } catch { /* gateway offline */ }
    })();
  }, [p.id, modelId]);

  const routeUrl = `${GATEWAY}/v1/route/${p.id}/chat/completions`;
  const mcp = `execute_x402_endpoint({\n  url: "${routeUrl}",\n  method: "POST",\n  data: {\n    model: "${modelId}",\n    messages: [{ role: "user", content: ${JSON.stringify(prompt)} }]\n  }\n})`;
  const curl = `curl -X POST ${routeUrl} \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify({ model: modelId, messages: [{ role: "user", content: prompt }] })}'`;

  return (
    <div className="overlay-in fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/65 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="modal-in my-6 w-full max-w-2xl rounded-2xl border border-[#23262d] bg-[#101216] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-[#f7931a]/12 text-base font-semibold text-[#f7931a]">{p.name.charAt(0).toUpperCase()}</span>
            <div>
              <h2 className="wide text-lg">{p.name}</h2>
              <span className="flex items-center gap-1.5 text-xs">
                <span className="h-2 w-2 rounded-full" style={{ background: st.c }} />
                <span style={{ color: st.c }}>{st.label}</span>
                {p.health?.latencyMs != null && <span className="text-[#9aa3af]">· {p.health.latencyMs}ms</span>}
                {p.health?.x402 && <span className="text-[#9aa3af]">· x402</span>}
              </span>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-[#9aa3af] hover:bg-[#15181d] hover:text-[#f2f4f7]">✕</button>
        </div>

        {p.description && <p className="mt-3 text-sm text-[#cfd5dd]">{p.description}</p>}

        <div className="mt-4 grid gap-2 text-xs text-[#9aa3af]">
          <div>endpoint <span className="mono break-all text-[#cfd5dd]">{p.endpoint}</span></div>
          <div>pays to <span className="mono text-[#cfd5dd]">{p.payoutAddress}</span></div>
        </div>

        {quote && (
          <div className="mt-3 rounded-lg border border-[#f7931a]/30 bg-[#f7931a]/[0.06] px-3 py-2.5 text-sm">
            <span className="text-[#9aa3af]">pay-per-call </span>
            <span className="text-[#f7931a]">≈ {formatPrice(quote.amount, quote.asset)}</span>
            <span className="text-[#9aa3af]"> · settled to the provider via our x402 wrapper</span>
          </div>
        )}

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
                {m.pricePerMTokenUsd != null && <span className="text-xs text-[#9aa3af]">${m.pricePerMTokenUsd}/Mtok</span>}
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
            <button onClick={run} disabled={running || p.status === "down"} className="rounded-lg bg-[#f7931a] px-4 py-1.5 text-sm font-medium text-[#1a1206] transition-opacity hover:opacity-90 disabled:opacity-50">
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

function RegisterModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  useEscape(onClose);
  const [tab, setTab] = useState<"local" | "public">("local");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const [lf, setLf] = useState({ name: "", payoutAddress: "", models: "", port: "11434" });
  const [src, setSrc] = useState("");
  const [pubKey, setPubKey] = useState("");

  async function sendPublic(payload: Record<string, unknown>) {
    setBusy(true); setResult(null);
    try {
      const r = await fetch(`${GATEWAY}/v1/providers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const j = await r.json();
      if (r.ok) { setResult({ ok: true, msg: "Verified ✓ reachable + serving inference." }); onDone(); setTimeout(onClose, 1400); }
      else setResult({ ok: false, msg: j.error || "Couldn't verify that endpoint." });
    } catch { setResult({ ok: false, msg: "Gateway unreachable." }); }
    finally { setBusy(false); }
  }

  const inputCls = "w-full rounded-lg border border-[#23262d] bg-[#0b0d10] px-3 py-2.5 text-sm outline-none placeholder:text-[#5b626c] focus:border-[#f7931a]";
  const gw = typeof window !== "undefined" ? window.location.origin : GATEWAY;
  const cmd = `curl -fsSL ${gw}/connect.sh | NAME=${JSON.stringify(lf.name || "My node")} WALLET=${lf.payoutAddress || "SP..."} MODELS=${lf.models || "qwen2.5-7b"} PORT=${lf.port || "11434"} GATEWAY=${gw} bash`;

  return (
    <div className="overlay-in fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="modal-in w-full max-w-md rounded-2xl border border-[#23262d] bg-[#101216] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="wide text-lg">List your model</h2>
            <p className="mt-1 text-sm text-[#9aa3af]">Get paid in sBTC for serving inference.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-[#9aa3af] hover:bg-[#15181d] hover:text-[#f2f4f7]">✕</button>
        </div>

        <div className="mt-4 flex gap-1 rounded-lg border border-[#23262d] bg-[#0b0d10] p-1 text-sm">
          {(["local", "public"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`flex-1 rounded-md py-1.5 ${tab === t ? "bg-[#15181d] text-[#f2f4f7]" : "text-[#9aa3af]"}`}>
              {t === "local" ? "Running locally" : "Already public"}
            </button>
          ))}
        </div>

        {tab === "local" ? (
          <div className="mt-4">
            {[
              { k: "name" as const, label: "Display name", ph: "Alice's Qwen node" },
              { k: "payoutAddress" as const, label: "Payout wallet", ph: "SP…" },
              { k: "models" as const, label: "Model ids (comma-separated)", ph: "qwen2.5-7b" },
              { k: "port" as const, label: "Local model port", ph: "11434" },
            ].map((f) => (
              <label key={f.k} className="mb-3 block">
                <span className="mb-1.5 block text-xs text-[#9aa3af]">{f.label}</span>
                <input value={lf[f.k]} onChange={(e) => setLf({ ...lf, [f.k]: e.target.value })} placeholder={f.ph} className={inputCls} />
              </label>
            ))}
            <p className="mb-2 mt-1 text-xs text-[#9aa3af]">Run this one command — it secures your model behind a key, tunnels it, and lists it:</p>
            <Snippet label="one command — secures · tunnels · registers" code={cmd} />
            <p className="mt-2 text-xs text-[#9aa3af]">Keep it running. Your node appears in the list once it&apos;s live.</p>
            <p className="mt-2 rounded-md border border-[#ffbf2e]/25 bg-[#ffbf2e]/[0.06] px-2.5 py-2 text-xs text-[#9aa3af]">
              ⚠️ <span className="text-[#ffbf2e]">Temporary</span> — the URL changes on restart, ~200 concurrent max. For a permanent URL:
            </p>
            <p className="mb-2 mt-3 text-xs text-[#9aa3af]">Permanent (named tunnel on your Cloudflare account):</p>
            <Snippet
              label="one-time setup, then run connect.sh with TUNNEL= HOST="
              code={`cloudflared tunnel login\ncloudflared tunnel create my-node\ncloudflared tunnel route dns my-node node.yourdomain.com\n\nTUNNEL=my-node HOST=node.yourdomain.com \\\n  NAME=${JSON.stringify(lf.name || "My node")} WALLET=${lf.payoutAddress || "SP..."} MODELS=${lf.models || "qwen2.5-7b"} PORT=${lf.port || "11434"} GATEWAY=${gw} \\\n  ./connect.sh`}
            />
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); const base = src.trim().endsWith(".json") ? { manifestUrl: src.trim() } : { endpoint: src.trim() }; sendPublic(pubKey.trim() ? { ...base, apiKey: pubKey.trim() } : base); }} className="mt-4">
            <label className="block">
              <span className="mb-1.5 block text-xs text-[#9aa3af]">Public endpoint or schema.json URL</span>
              <input required value={src} onChange={(e) => setSrc(e.target.value)} placeholder="https://your-host/v1" className={inputCls} />
            </label>
            <label className="mt-3 block">
              <span className="mb-1.5 block text-xs text-[#9aa3af]">API key (optional — if your endpoint requires one)</span>
              <input value={pubKey} onChange={(e) => setPubKey(e.target.value)} placeholder="leave blank if open" className={inputCls} />
            </label>
            <p className="mt-2 text-xs text-[#9aa3af]">Already on a server? Paste the URL — we verify and list it.</p>
            <button disabled={busy} className="mt-4 w-full rounded-lg bg-[#f7931a] py-3 text-sm font-medium text-[#1a1206] transition-opacity hover:opacity-90 disabled:opacity-60">{busy ? "Verifying…" : "Register & verify"}</button>
          </form>
        )}

        {result && (
          <div className="mt-3.5 rounded-lg border px-3 py-2.5 text-sm" style={result.ok ? { borderColor: "rgba(53,199,89,.4)", background: "rgba(53,199,89,.08)" } : { borderColor: "rgba(255,77,79,.4)", background: "rgba(255,77,79,.08)" }}>
            {result.msg}
          </div>
        )}
      </div>
    </div>
  );
}
