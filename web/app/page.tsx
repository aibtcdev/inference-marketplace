"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

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
          <div className="flex items-center gap-3">
            <span
              title="This marketplace runs on Stacks testnet — endpoints and payments settle in testnet sBTC."
              className="inline-flex items-center gap-1.5 rounded-full border border-[#3a2f12] bg-[#1a1206] px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider text-[#f7931a]"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[#f7931a]" />
              Testnet
            </span>
            <button onClick={() => setModal(true)} className="rounded-lg bg-[#f7931a] px-4 py-2 text-[13px] font-medium text-[#1a1206] transition-opacity hover:opacity-90">
              Register endpoint
            </button>
          </div>
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
  const [watching, setWatching] = useState(false);

  const [lf, setLf] = useState({ name: "", payoutAddress: "", models: "", port: "11434", host: "" });
  const [src, setSrc] = useState("");
  const [pubKey, setPubKey] = useState("");
  // Inline fields for an already-public endpoint (skipped when a schema.json URL
  // is pasted — the manifest carries name/wallet/models itself).
  const [pf, setPf] = useState({ name: "", payoutAddress: "", models: "" });

  // After the user runs the connect command on their machine, the script
  // registers itself — so we poll the directory and confirm the moment the
  // node shows up (matched by wallet + display name).
  useEffect(() => {
    if (!watching) return;
    let alive = true;
    const want = { name: lf.name.trim(), wallet: lf.payoutAddress.trim() };
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
  }, [watching, lf.name, lf.payoutAddress, onDone, onClose]);

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

  // A schema.json URL self-describes; a bare endpoint needs name/wallet/models
  // supplied inline. We send the inline fields verbatim — the gateway validates
  // the models against Hugging Face and verifies the endpoint before listing.
  const pubIsManifest = src.trim().endsWith(".json");
  const pubReady = !!src.trim() && (pubIsManifest || !!(pf.name.trim() && pf.payoutAddress.trim() && pf.models.trim()));

  function submitPublic(e: FormEvent) {
    e.preventDefault();
    const url = src.trim();
    const apiKey = pubKey.trim() || undefined;
    if (pubIsManifest) {
      sendPublic({ manifestUrl: url, ...(apiKey ? { apiKey } : {}) });
      return;
    }
    const models = pf.models.split(",").map((m) => m.trim()).filter(Boolean);
    sendPublic({
      name: pf.name.trim(),
      endpoint: url,
      payoutAddress: pf.payoutAddress.trim(),
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
  const wallet = lf.payoutAddress.trim();
  const port = lf.port.trim() || "11434";
  const models = lf.models.split(",").map((m) => m.trim()).filter(Boolean).join(",");
  const ready = !!(name && wallet && models);
  const cmd = `curl -fsSL ${gw}/connect.sh | NAME=${JSON.stringify(name)} WALLET=${wallet} MODELS=${JSON.stringify(models)} PORT=${port} GATEWAY=${gw} bash`;
  const host = lf.host.trim() || "node.yourdomain.com";
  const tunnel = (lf.host.trim().split(".")[0] || "my-node").replace(/[^a-z0-9-]/gi, "-");
  const permaCmd = `cloudflared tunnel login\ncloudflared tunnel create ${tunnel}\ncloudflared tunnel route dns ${tunnel} ${host}\n\nTUNNEL=${tunnel} HOST=${host} \\\n  NAME=${JSON.stringify(name)} WALLET=${wallet} MODELS=${JSON.stringify(models)} PORT=${port} GATEWAY=${gw} \\\n  ./connect.sh`;

  return (
    <div className="overlay-in fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm sm:p-6" onClick={onClose}>
      <div className="modal-in flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[#23262d] bg-[#101216] shadow-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="flex shrink-0 items-start justify-between border-b border-[#23262d] px-5 py-4 sm:px-6">
          <div>
            <h2 className="wide text-lg">List your model</h2>
            <p className="mt-1 text-sm text-[#9aa3af]">Get paid in sBTC for serving inference. You keep <span className="text-[#35c759]">92%</span>.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-[#9aa3af] hover:bg-[#15181d] hover:text-[#f2f4f7]">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          <div className="w-full">
        <div className="flex gap-1 rounded-lg border border-[#23262d] bg-[#0b0d10] p-1 text-sm">
          {(["local", "public"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`flex-1 rounded-md py-1.5 ${tab === t ? "bg-[#15181d] text-[#f2f4f7]" : "text-[#9aa3af]"}`}>
              {t === "local" ? "Running locally" : "Already public"}
            </button>
          ))}
        </div>

        <p className="mt-3 rounded-md border border-[#35c759]/25 bg-[#35c759]/[0.06] px-2.5 py-2 text-[11px] leading-relaxed text-[#9aa3af]">
          <span className="text-[#f2f4f7]">Fee:</span> each paid request settles on-chain, non-custodial — <span className="text-[#35c759]">92% goes straight to your payout wallet</span>, an <span className="text-[#f2f4f7]">8%</span> fee routes to the model&apos;s legion treasury. No listing fee, no fee to join.
        </p>

        {tab === "local" ? (
          <div className="mt-4">
            <p className="mb-3 text-xs text-[#9aa3af]"><span className="text-[#f2f4f7]">Step 1.</span> Your node details (these fill the command below):</p>
            {[
              { k: "name" as const, label: "Display name", ph: "Alice's Qwen node" },
              { k: "payoutAddress" as const, label: "Payout wallet", ph: "SP…" },
            ].map((f) => (
              <label key={f.k} className="mb-3 block">
                <span className="mb-1.5 block text-xs text-[#9aa3af]">{f.label}</span>
                <input value={lf[f.k]} onChange={(e) => setLf({ ...lf, [f.k]: e.target.value })} placeholder={f.ph} className={inputCls} />
              </label>
            ))}
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
            <p className="mb-2 mt-1 text-xs text-[#9aa3af]"><span className="text-[#f2f4f7]">Step 2.</span> Pick one and run it in your terminal — it secures your model behind a key, tunnels it, and registers it. No submit here: the command does it.</p>

            <p className="mb-1.5 mt-3 text-[11px] uppercase tracking-wide text-[#5b626c]">Option A · quick (temporary URL)</p>
            {ready ? (
              <Snippet label="one command — secures · tunnels · registers" code={cmd} />
            ) : (
              <div className="rounded-lg border border-dashed border-[#2a2e36] bg-[#0b0d10] px-3 py-3 text-xs text-[#5b626c]">Fill name, wallet &amp; model above — your command appears here.</div>
            )}
            <p className="mt-1.5 rounded-md border border-[#ffbf2e]/25 bg-[#ffbf2e]/[0.06] px-2.5 py-2 text-[11px] text-[#9aa3af]">
              ⚠️ <span className="text-[#ffbf2e]">Temporary</span> — the URL changes on restart, ~200 concurrent max. Fine for a demo; use Option B for a real node.
            </p>

            <p className="mb-1.5 mt-4 text-[11px] uppercase tracking-wide text-[#5b626c]">Option B · permanent (named tunnel on your Cloudflare account)</p>
            <label className="mb-2 block">
              <span className="mb-1.5 block text-xs text-[#9aa3af]">Your hostname (a subdomain on a domain in your Cloudflare account)</span>
              <input value={lf.host} onChange={(e) => setLf({ ...lf, host: e.target.value })} placeholder="qwen.aibtc.com" className={inputCls} />
            </label>
            {ready ? (
              <Snippet label="one-time setup, then run connect.sh with TUNNEL= HOST=" code={permaCmd} />
            ) : (
              <div className="rounded-lg border border-dashed border-[#2a2e36] bg-[#0b0d10] px-3 py-3 text-xs text-[#5b626c]">Fill name, wallet &amp; model above — your command appears here.</div>
            )}

            <div className="mt-5 border-t border-[#23262d] pt-4">
              <p className="mb-2 text-xs text-[#9aa3af]"><span className="text-[#f2f4f7]">Step 3.</span> Whichever you ran, keep it running — then watch for your node to appear:</p>
              {watching ? (
                <button onClick={() => setWatching(false)} className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#23262d] bg-[#0b0d10] py-3 text-sm text-[#9aa3af] hover:text-[#f2f4f7]">
                  <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#f7931a] border-t-transparent" />
                  Watching for your node… (cancel)
                </button>
              ) : (
                <button
                  onClick={() => { setResult(null); setWatching(true); }}
                  disabled={!lf.name.trim() || !lf.payoutAddress.trim()}
                  className="w-full rounded-lg bg-[#f7931a] py-3 text-sm font-medium text-[#1a1206] transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  I&apos;ve run it — watch for my node
                </button>
              )}
              {!lf.name.trim() || !lf.payoutAddress.trim() ? (
                <p className="mt-1.5 text-[11px] text-[#5b626c]">Fill name + wallet above so we can match your node.</p>
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
                <label className="mt-3 block">
                  <span className="mb-1.5 block text-xs text-[#9aa3af]">Payout wallet</span>
                  <input value={pf.payoutAddress} onChange={(e) => setPf({ ...pf, payoutAddress: e.target.value })} placeholder="SP…" className={inputCls} />
                </label>
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
