/**
 * Provider health checks.
 *
 * Probes a registered provider's inference endpoint to decide whether it's
 * live / degraded / down. Used on registration (instant feedback) and on a
 * cron schedule (continuous monitoring).
 *
 * Liveness probe = GET {endpoint}/models (every OpenAI-compatible server
 * exposes it). We treat:
 *   200 → reachable
 *   402 → reachable AND x402-payment-gated (a paid provider)
 *   else / timeout / network error → down
 */

export type HealthStatus = 'live' | 'degraded' | 'down';

export interface HealthResult {
  status: HealthStatus;
  latencyMs: number;
  httpCode: number;
  x402: boolean;
  checkedAt: string;
  error?: string;
}

const TIMEOUT_MS = 8000;
const DEGRADED_MS = 4000;

export interface VerifyResult {
  ok: boolean;          // passes the gate (reachable AND functional)
  reachable: boolean;   // endpoint responded to /models
  functional: boolean;  // actually returned a completion
  health: HealthResult;
  servedModel?: string;
  sample?: string;      // first chars of the model's reply (proof it works)
  error?: string;
}

/**
 * Deep verification used at registration: confirm the endpoint is reachable AND
 * that it actually serves inference (does what it claims) before we confirm it.
 * An endpoint that correctly answers HTTP 402 (x402 payment required) counts as
 * functional — it's behaving, it just needs payment to run.
 */
export async function verifyProvider(endpoint: string, apiKey?: string): Promise<VerifyResult> {
  const base = endpoint.replace(/\/$/, '');
  // A freshly-created tunnel can take ~30-60s to become globally resolvable —
  // retry the reachability check before giving up.
  let health = await checkEndpoint(base, apiKey);
  for (let i = 0; i < 5 && health.status === 'down'; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    health = await checkEndpoint(base, apiKey);
  }
  if (health.status === 'down') {
    return { ok: false, reachable: false, functional: false, health, error: `Endpoint not reachable (${health.error || 'no response'})` };
  }

  // Discover a served model name for the probe.
  let servedModel: string | undefined;
  try {
    const mr = await fetch(`${base}/models`, { headers: authHeaders(apiKey), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const md = (await mr.json()) as { data?: Array<{ id?: string }> };
    servedModel = md?.data?.[0]?.id;
  } catch { /* fall through */ }

  // Functional probe: a real (tiny) inference call.
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model: servedModel,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        max_tokens: 10,
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (r.status === 402) {
      // Already x402-gated upstream — still counts as functional.
      return { ok: true, reachable: true, functional: true, health, servedModel, sample: '(endpoint already x402-gated)' };
    }
    const j = (await r.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: unknown;
    };
    const content = j.choices?.[0]?.message?.content;
    if (r.ok && typeof content === 'string' && content.trim().length > 0) {
      return { ok: true, reachable: true, functional: true, health, servedModel, sample: content.trim().slice(0, 120) };
    }
    const why = typeof j.error === 'string' ? j.error : `HTTP ${r.status}`;
    return { ok: false, reachable: true, functional: false, health: { ...health, status: 'degraded' }, servedModel, error: `Reachable, but inference failed (${why})` };
  } catch (e) {
    return { ok: false, reachable: true, functional: false, health: { ...health, status: 'degraded' }, servedModel, error: `Reachable, but the inference probe failed (${e instanceof Error ? e.message : String(e)})` };
  }
}

function authHeaders(apiKey?: string, extra?: Record<string, string>): Record<string, string> {
  return { ...(extra ?? {}), ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
}

export async function checkEndpoint(endpoint: string, apiKey?: string): Promise<HealthResult> {
  const url = `${endpoint.replace(/\/$/, '')}/models`;
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();

  try {
    const res = await fetch(url, { method: 'GET', headers: authHeaders(apiKey), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const latencyMs = Date.now() - startedAt;
    const x402 = res.status === 402;

    if (res.status === 200 || res.status === 402) {
      return { status: latencyMs > DEGRADED_MS ? 'degraded' : 'live', latencyMs, httpCode: res.status, x402, checkedAt };
    }
    return { status: 'down', latencyMs, httpCode: res.status, x402: false, checkedAt, error: `HTTP ${res.status}` };
  } catch (e) {
    return {
      status: 'down',
      latencyMs: Date.now() - startedAt,
      httpCode: 0,
      x402: false,
      checkedAt,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
