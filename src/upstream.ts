/**
 * Upstream inference client — talks to ANY OpenAI-compatible endpoint:
 *   - Hugging Face Inference Endpoints (TGI / Messages API)
 *   - vLLM / SGLang  (`/v1/chat/completions`)
 *   - any self-hosted open-weight model server
 *
 * The gateway is a real compute provider: it points at a model server it (or a
 * registered provider) controls. No proprietary API is resold.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  [k: string]: unknown;
}

export interface ChatCompletionBody {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: unknown;
  tool_choice?: unknown;
  stream?: boolean;
  [k: string]: unknown;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function authHeaders(apiKey: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

/**
 * OpenAI-compatible passthrough. Forwards the request verbatim (messages, tools,
 * temperature, ...) to `${baseUrl}/chat/completions` and returns the raw upstream
 * JSON, so the gateway is a drop-in for any OpenAI/HF/vLLM client. `model` is set
 * by the caller after price resolution so the paid-for model is the served model.
 */
export const UPSTREAM_TIMEOUT_MS = 120_000;

export async function proxyChatCompletion(
  baseUrl: string,
  apiKey: string,
  body: ChatCompletionBody,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
): Promise<{ status: number; json: unknown }> {
  // Runs after settlement, so never throw: a network error or hung provider
  // becomes a 502/504 the caller can still attach the payment receipt to.
  let response: Response;
  try {
    response = await fetch(joinUrl(baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: authHeaders(apiKey),
      // stream is not supported through the paid gateway yet — strip it.
      body: JSON.stringify({ ...body, stream: false, max_tokens: body.max_tokens ?? 1024 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return timedOut
      ? { status: 504, json: { error: 'Upstream provider timed out' } }
      : { status: 502, json: { error: 'Upstream provider unreachable', details: String(e) } };
  }

  const json = await response.json().catch(() => ({ error: 'Invalid upstream response' }));
  return { status: response.status, json };
}
