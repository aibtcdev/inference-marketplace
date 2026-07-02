"use client";

// Shared types, constants, and the provider-management UI used by both the
// marketplace (/) and the owner dashboard (/dashboard).
import { useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";
import { signAuthHeaders } from "./wallet";

// Same-origin in production (the Worker serves both UI and API); override via
// NEXT_PUBLIC_GATEWAY_URL for split local dev (next dev + wrangler dev).
export const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "";

export type Health = { status: string; latencyMs: number; x402: boolean; checkedAt: string; error?: string } | null;
export type ModelSpec = { id: string; name?: string; contextLength?: number; capabilities?: string[]; pricePerMTokenUsd?: number };
export type Provider = {
  id: string;
  name: string;
  endpoint: string;
  api: string;
  payoutAddress: string;
  models: ModelSpec[];
  description?: string;
  status: "live" | "degraded" | "down" | "pending";
  health: Health;
  /** True when the endpoint requires the gateway's shared key (locked against
   *  freeloaders). False/undefined = open endpoint; the key flow is irrelevant. */
  secured?: boolean;
};

export const STATUS: Record<string, { c: string; label: string }> = {
  live: { c: "#35c759", label: "live" },
  degraded: { c: "#ffbf2e", label: "degraded" },
  down: { c: "#ff4d4f", label: "down" },
  pending: { c: "#6b7280", label: "checking" },
};

export const trunc = (a: string) => (a && a.length > 16 ? `${a.slice(0, 9)}…${a.slice(-5)}` : a);

/** The connected wallet's own endpoints, with wallet-signed management. */
export function MyEndpoints({ items, onChanged, onRegister }: { items: Provider[]; onChanged: () => void; onRegister: () => void }) {
  return (
    <div className="rounded-xl border border-[#f7931a]/25 bg-[#f7931a]/[0.04] p-4">
      <h2 className="text-lg font-medium">Your endpoints</h2>
      <p className="mb-3 mt-0.5 text-xs text-[#9aa3af]">Paid to your connected wallet — manage them with a wallet signature (no key to remember).</p>
      {items.length === 0 ? (
        <p className="text-sm text-[#9aa3af]">None yet. <button onClick={onRegister} className="font-medium text-[#f7931a] hover:opacity-90">Register an endpoint →</button></p>
      ) : (
        <div className="space-y-3">
          {items.map((p) => <EndpointCard key={p.id} p={p} onChanged={onChanged} />)}
        </div>
      )}
    </div>
  );
}

function EndpointCard({ p, onChanged }: { p: Provider; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [showProtect, setShowProtect] = useState(false);
  const [form, setForm] = useState({ name: p.name, models: p.models.map((m) => m.id).join(", "), payoutAddress: p.payoutAddress, apiKey: "" });
  const secured = !!p.secured;

  // Sign with the payout wallet, then call the gateway.
  async function callSigned(action: "update" | "reveal-key", path: string, method: "PATCH" | "POST", body: object) {
    const headers = await signAuthHeaders(action, p.id);
    const r = await fetch(`${GATEWAY}${path}`, { method, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "request failed");
    return j;
  }

  async function revealKey(rotate: boolean) {
    setBusy(rotate ? "rotate" : "reveal"); setKey(null);
    try {
      const j = await callSigned("reveal-key", `/v1/providers/${p.id}/key`, "POST", rotate ? { rotate: true } : {});
      if (j.key) { setKey(j.key); toast.success(rotate ? "Key generated — see below" : "Key revealed below"); }
      else toast.message(j.message || "No shared key set.");
      if (rotate) onChanged();
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(null); }
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    setBusy("edit");
    try {
      const models = form.models.split(",").map((s) => s.trim()).filter(Boolean).map((id) => ({ id }));
      const apiKey = form.apiKey.trim();
      await callSigned("update", `/v1/providers/${p.id}`, "PATCH", {
        name: form.name.trim(),
        payoutAddress: form.payoutAddress.trim(),
        models,
        ...(apiKey ? { apiKey } : {}),
      });
      toast.success(apiKey ? "Saved — endpoint now requires this key" : "Saved");
      setEditing(false); setForm((f) => ({ ...f, apiKey: "" })); onChanged();
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(null); }
  }

  const btn = "rounded-lg border border-[#23262d] bg-[#0b0d10] px-3 py-1.5 text-xs text-[#cfd5dd] transition-colors hover:text-[#f2f4f7] disabled:opacity-50";
  const inp = "w-full rounded-md border border-[#23262d] bg-[#0b0d10] px-2.5 py-2 text-sm outline-none focus:border-[#f7931a]";
  return (
    <div className="rounded-lg border border-[#23262d] bg-[#0c0e12] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{p.name}</span>
            <span
              title={secured ? "Locked: only the gateway (holding the shared key) can call this endpoint." : "Open: anyone with the URL can call this endpoint directly, bypassing payment."}
              className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${secured ? "border-[#123a1c] bg-[#06140b] text-[#35c759]" : "border-[#23262d] bg-[#15181d] text-[#9aa3af]"}`}
            >
              {secured ? "🔒 protected" : "open"}
            </span>
          </div>
          <div className="mono mt-0.5 break-all text-xs text-[#9aa3af]">{p.endpoint}</div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {secured && <button className={btn} disabled={!!busy} onClick={() => revealKey(false)}>{busy === "reveal" ? "…" : "Reveal key"}</button>}
          {secured && <button className={btn} disabled={!!busy} onClick={() => revealKey(true)}>{busy === "rotate" ? "…" : "Rotate"}</button>}
          <button className={btn} disabled={!!busy} onClick={() => setEditing((v) => !v)}>Edit</button>
        </div>
      </div>

      {key && (
        <div className="mt-2">
          <div className="mono break-all rounded-md border border-[#35c759]/30 bg-[#35c759]/[0.06] p-2 text-xs text-[#cfd5dd]">{key}</div>
          <p className="mt-1 text-[11px] text-[#9aa3af]">This is the credential the gateway sends to your endpoint. Your endpoint must require it (proxy / Cloudflare Access) — otherwise it&apos;s ignored.</p>
        </div>
      )}

      {/* Open endpoint: the key flow is optional and off by default. */}
      {!secured && !editing && (
        <div className="mt-2 border-t border-[#23262d] pt-2">
          <button onClick={() => setShowProtect((v) => !v)} className="text-[11px] text-[#9aa3af] hover:text-[#f2f4f7]">
            {showProtect ? "▾" : "▸"} Protect this endpoint (optional)
          </button>
          {showProtect && (
            <div className="mt-2 space-y-2 text-[11px] leading-relaxed text-[#9aa3af]">
              <p>This endpoint is <b className="text-[#cfd5dd]">open</b> — anyone with the URL can use your model for free, skipping payment. To require payment, lock it so only the gateway can call it:</p>
              <ul className="ml-3.5 list-disc space-y-1">
                <li><b className="text-[#cfd5dd]">Your endpoint already needs an API key?</b> Click <b>Edit</b> and add it — the gateway will present it on every call.</li>
                <li><b className="text-[#cfd5dd]">No auth of its own?</b> Generate a gateway key below, then put a proxy (or Cloudflare Access) in front of your endpoint that requires it.</li>
              </ul>
              <button className={btn} disabled={!!busy} onClick={() => revealKey(true)}>{busy === "rotate" ? "…" : "Generate key"}</button>
            </div>
          )}
        </div>
      )}

      {editing && (
        <form onSubmit={saveEdit} className="mt-3 space-y-2 border-t border-[#23262d] pt-3">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Display name" className={inp} />
          <input value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} placeholder="Model ids (comma-separated)" className={`mono ${inp} text-xs`} />
          <input value={form.payoutAddress} onChange={(e) => setForm({ ...form, payoutAddress: e.target.value })} placeholder="Payout address" className={`mono ${inp} text-xs`} />
          <input value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={secured ? "Replace API key (optional)" : "API key to require (optional — locks this endpoint)"} className={`mono ${inp} text-xs`} />
          <button disabled={!!busy} className="rounded-lg bg-[#f7931a] px-3 py-1.5 text-xs font-medium text-[#1a1206] disabled:opacity-60">{busy === "edit" ? "Signing…" : "Sign & save"}</button>
        </form>
      )}
    </div>
  );
}
