/**
 * Model Catalog
 *
 * Open-weight models the marketplace serves from its own / registered upstreams
 * (Hugging Face Inference Endpoints, vLLM, etc.). Serving open weights
 * commercially is permitted by their licenses — no proprietary API is resold.
 *
 * Each entry carries:
 *   - id            : marketplace-facing model id (what agents request)
 *   - upstreamModel : the name the upstream server expects (HF repo id /
 *                     vLLM --served-model-name)
 *   - costPer1kUsd  : YOUR estimated cost to serve 1k tokens, in USD. This is
 *                     the pricing basis (GPU $/hr ÷ throughput). TUNE per
 *                     deployment — these are conservative placeholders. The
 *                     dynamic engine charges costPer1kUsd × tokens × markup,
 *                     then converts to sBTC/USDCx at the live rate (pricing.ts).
 *
 * License notes: Qwen2.5 (≤32B) & Mistral-Nemo are Apache-2.0; Llama 3.x is
 * commercial-OK under 700M MAU with "Built with Llama" attribution; verify the
 * exact checkpoint before serving.
 */

export type Tier = 'small' | 'mid' | 'large';

export interface ModelEntry {
  id: string;
  name: string;
  upstreamModel: string;
  tier: Tier;
  contextLength: number;
  /** Operator's serving cost per 1k tokens (USD). Pricing basis — tune this. */
  costPer1kUsd: number;
  /** Provider that serves this model (see registry.ts). */
  providerId: string;
  bestFor: string;
}

export const MODELS: ModelEntry[] = [
  {
    id: 'qwen2.5-7b',
    name: 'Qwen2.5 7B Instruct',
    upstreamModel: 'Qwen/Qwen2.5-7B-Instruct',
    tier: 'small',
    contextLength: 131072,
    costPer1kUsd: 0.0002,
    providerId: 'house',
    bestFor: 'Fast, cheap general chat (Apache-2.0)',
  },
  {
    id: 'llama-3.1-8b',
    name: 'Llama 3.1 8B Instruct',
    upstreamModel: 'meta-llama/Llama-3.1-8B-Instruct',
    tier: 'small',
    contextLength: 131072,
    costPer1kUsd: 0.0002,
    providerId: 'house',
    bestFor: 'Cheap, solid general use',
  },
  {
    id: 'mistral-nemo',
    name: 'Mistral Nemo Instruct',
    upstreamModel: 'mistralai/Mistral-Nemo-Instruct-2407',
    tier: 'small',
    contextLength: 131072,
    costPer1kUsd: 0.00025,
    providerId: 'house',
    bestFor: 'Long context, cheap (Apache-2.0)',
  },
  {
    id: 'qwen2.5-32b',
    name: 'Qwen2.5 32B Instruct',
    upstreamModel: 'Qwen/Qwen2.5-32B-Instruct',
    tier: 'mid',
    contextLength: 131072,
    costPer1kUsd: 0.0009,
    providerId: 'house',
    bestFor: 'Strong reasoning + coding (Apache-2.0)',
  },
  {
    id: 'llama-3.3-70b',
    name: 'Llama 3.3 70B Instruct',
    upstreamModel: 'meta-llama/Llama-3.3-70B-Instruct',
    tier: 'large',
    contextLength: 131072,
    costPer1kUsd: 0.002,
    providerId: 'house',
    bestFor: 'Best open-weight quality',
  },
  {
    id: 'deepseek-r1-32b',
    name: 'DeepSeek R1 Distill Qwen 32B',
    upstreamModel: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B',
    tier: 'mid',
    contextLength: 131072,
    costPer1kUsd: 0.001,
    providerId: 'house',
    bestFor: 'Chain-of-thought reasoning',
  },
];

const MODELS_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

export function getModel(id: string): ModelEntry | undefined {
  return MODELS_BY_ID.get(id);
}

/** Default model for the simple /v1/chat demo endpoint. */
export const DEFAULT_MODEL = MODELS[0];
