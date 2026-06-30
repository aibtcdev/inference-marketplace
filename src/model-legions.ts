/**
 * Per-model legion resolution.
 *
 * Each supported model family is its own on-chain legion (treasury + fees + gov),
 * all deployed under ONE owner (LEGION_OWNER) with the contract name suffixed by
 * the family, e.g. `STGX5YP….legion-fees-qwen`. A provider picks its model from
 * the supported set at registration, so every served model maps 1:1 to a legion:
 *
 *   - fees     → where this model's 8% skim routes (legion-fees-<family>.route)
 *   - treasury → that model's pooled sBTC (the commons its members govern)
 *   - gov      → that model's stake/vote/propose ledger (also the ranking signal)
 *
 * Resolution is by family keyword so model variants (qwen2.5-7b, qwen2.5-32b, …)
 * all map to the same legion. Unknown models return {} → callers fall back to the
 * legacy single-legion env (LEGION_FEES / LEGION_ENGAGE) so nothing breaks.
 */

/** Supported legion families. Drives the provider registration dropdown. */
export const LEGION_FAMILIES = ['qwen', 'deepseek', 'glm5', 'kimi', 'llama4', 'mistral', 'gemma4'] as const;
export type LegionFamily = (typeof LEGION_FAMILIES)[number];

/** Family keyword match — variants fold into one legion. First match wins. */
const FAMILY_PATTERNS: Array<[RegExp, LegionFamily]> = [
  [/qwen/i, 'qwen'],
  [/deepseek/i, 'deepseek'],
  [/\bglm\b|z-?ai|zhipu/i, 'glm5'],
  [/kimi|moonshot/i, 'kimi'],
  [/llama|meta-llama/i, 'llama4'],
  [/mistral|mixtral|nemo|ministral/i, 'mistral'],
  [/gemma/i, 'gemma4'],
];

/** Map a gateway model id (e.g. "Qwen/Qwen2.5-7B-Instruct") to its legion family, or null. */
export function familyForModel(modelId: string | undefined): LegionFamily | null {
  if (!modelId) return null;
  for (const [re, fam] of FAMILY_PATTERNS) if (re.test(modelId)) return fam;
  return null;
}

export interface ModelLegion {
  family: LegionFamily;
  treasury: string;
  fees: string;
  gov: string;
}

/**
 * Resolve the legion contracts for a model. Returns null when the owner isn't
 * configured or the model isn't one of ours (caller falls back to legacy env).
 */
export function legionForModel(env: any, modelId: string | undefined): ModelLegion | null {
  const owner: string | undefined = env?.LEGION_OWNER;
  const fam = familyForModel(modelId);
  if (!owner || !fam) return null;
  return {
    family: fam,
    treasury: `${owner}.legion-treasury-${fam}`,
    fees: `${owner}.legion-fees-${fam}`,
    gov: `${owner}.legion-gov-${fam}`,
  };
}
