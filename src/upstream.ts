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

export interface UpstreamResponse {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

interface UpstreamAPIResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { role?: string; content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
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
export async function proxyChatCompletion(
  baseUrl: string,
  apiKey: string,
  body: ChatCompletionBody,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(joinUrl(baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: authHeaders(apiKey),
    // stream is not supported through the paid gateway yet — strip it.
    body: JSON.stringify({ ...body, stream: false, max_tokens: body.max_tokens ?? 1024 }),
  });

  const json = await response.json().catch(() => ({ error: 'Invalid upstream response' }));
  return { status: response.status, json };
}

/** Simple single-prompt helper for the `/v1/chat` demo endpoint. */
export async function callUpstream(
  baseUrl: string,
  apiKey: string,
  request: { model: string; systemPrompt: string; userMessage: string; maxTokens?: number; temperature?: number },
): Promise<UpstreamResponse> {
  const { model, systemPrompt, userMessage, maxTokens = 1024, temperature = 0.7 } = request;

  const response = await fetch(joinUrl(baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: maxTokens,
      temperature,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Upstream error: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as UpstreamAPIResponse;
  return {
    content: data.choices?.[0]?.message?.content || '',
    model: data.model || model,
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    },
  };
}
