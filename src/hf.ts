/**
 * Hugging Face model validation.
 *
 * The catalog of valid model ids is the Hugging Face Hub itself. A provider
 * declares an HF repo id (e.g. "Qwen/Qwen2.5-7B-Instruct"); we confirm it's a
 * real, text-generation, commercially-licensed model before listing. This kills
 * made-up model names and non-commercial weights without us maintaining a list.
 */

export interface HfModelInfo {
  valid: boolean;
  id?: string;
  pipelineTag?: string;
  license?: string;
  error?: string;
}

// Clearly non-commercial license markers — reject these.
const NON_COMMERCIAL = /(^|[^a-z])(nc|noncommercial|non-commercial|research|cc-by-nc)/i;

/** owner/model, conservative charset (also guards the URL path). */
const VALID_ID = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;

export async function validateHfModel(id: string): Promise<HfModelInfo> {
  const repo = (id || '').trim();
  if (!VALID_ID.test(repo)) {
    return { valid: false, error: `"${id}" is not a Hugging Face repo id (expected owner/model, e.g. Qwen/Qwen2.5-7B-Instruct)` };
  }

  let res: Response;
  try {
    res = await fetch(`https://huggingface.co/api/models/${repo}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    return { valid: false, error: `Couldn't reach Hugging Face: ${e instanceof Error ? e.message : String(e)}` };
  }
  // HF answers 404/401/403 for unknown or non-public repos.
  if (res.status === 404 || res.status === 401 || res.status === 403) {
    return { valid: false, error: `Model not found (or not public) on Hugging Face: ${repo}` };
  }
  if (!res.ok) return { valid: false, error: `Hugging Face returned ${res.status} for ${repo}` };

  const m = (await res.json().catch(() => ({}))) as {
    id?: string;
    pipeline_tag?: string;
    tags?: string[];
    cardData?: { license?: string };
  };
  const tags = m.tags ?? [];

  const isText = m.pipeline_tag === 'text-generation' || tags.includes('text-generation') || tags.includes('conversational');
  if (!isText) return { valid: false, error: `${repo} is not a text-generation model` };

  const license =
    m.cardData?.license ||
    tags.find((t) => t.startsWith('license:'))?.slice('license:'.length) ||
    'unknown';
  if (NON_COMMERCIAL.test(license)) {
    return { valid: false, error: `${repo} has a non-commercial license (${license}) — can't be served for pay` };
  }

  return { valid: true, id: m.id ?? repo, pipelineTag: m.pipeline_tag, license };
}
