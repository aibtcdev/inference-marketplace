/**
 * Provider registration schema.
 *
 * The structured contract for listing an endpoint — served at `GET /v1/schema`
 * so humans (the form) and agents (programmatic registration) use the same
 * shape. Each provider declares structured per-model capability specs, not just
 * free-text ids.
 */

export const CAPABILITIES = ["chat", "tools", "vision", "reasoning", "embeddings"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Payment tokens a provider can be paid in. Clients pay the provider directly
 *  (non-custodial) in the provider's chosen token. */
export const PAYOUT_TOKENS = ["sBTC", "USDCx"] as const;
export type PayoutToken = (typeof PAYOUT_TOKENS)[number];
export const DEFAULT_PAYOUT_TOKEN: PayoutToken = "sBTC";

export interface ModelSpec {
  /** Marketplace model id agents request (e.g. "qwen2.5-7b"). */
  id: string;
  name?: string;
  contextLength?: number;
  capabilities?: Capability[];
}

export interface ProviderRegistration {
  name: string;
  /** OpenAI-compatible base URL (https, or http://localhost for local nodes). */
  endpoint: string;
  /** Stacks address that receives payment (SP… / SM…). */
  payoutAddress: string;
  /** API contract the endpoint speaks. */
  api: "openai-chat";
  /** Token this provider is paid in (default sBTC). */
  acceptedToken?: PayoutToken;
  /** Flat price per request, in the smallest unit of `acceptedToken`
   *  (sBTC: sats; USDCx: 0.000001 USDCx). This is the x402 `amount` charged. */
  pricePerRequest: string;
  models: ModelSpec[];
  description?: string;
}

/** JSON Schema (draft 2020-12) for `ProviderRegistration`. Served at /v1/schema. */
export const REGISTRATION_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://inference-marketplace/schemas/provider-registration",
  title: "ProviderRegistration",
  type: "object",
  required: ["name", "endpoint", "payoutAddress", "pricePerRequest", "models"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 64, description: "Display name" },
    endpoint: {
      type: "string",
      pattern: "^(https://.+|http://(localhost|127\\.0\\.0\\.1)(:\\d+)?(/.*)?)$",
      description: "OpenAI-compatible base URL, e.g. https://host/v1",
    },
    payoutAddress: {
      type: "string",
      pattern: "^S[PM][0-9A-Z]+$",
      description: "Stacks mainnet address that receives sBTC payment",
    },
    api: { type: "string", enum: ["openai-chat"], default: "openai-chat" },
    acceptedToken: {
      type: "string",
      enum: [...PAYOUT_TOKENS],
      default: DEFAULT_PAYOUT_TOKEN,
      description: "Token you are paid in: sBTC or USDCx",
    },
    pricePerRequest: {
      type: ["string", "integer"],
      pattern: "^[1-9][0-9]*$",
      minimum: 1,
      description: "Flat price per request in the smallest unit of acceptedToken — sats for sBTC (5 = 5 sats), 0.000001 USDCx for USDCx (2000 = 0.002 USDCx)",
    },
    description: { type: "string", maxLength: 280 },
    models: {
      type: "array",
      minItems: 1,
      description: "Models this endpoint serves",
      items: {
        type: "object",
        required: ["id"],
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, description: "Marketplace model id" },
          name: { type: "string" },
          contextLength: { type: "integer", minimum: 1 },
          capabilities: {
            type: "array",
            items: { type: "string", enum: [...CAPABILITIES] },
            uniqueItems: true,
          },
        },
      },
    },
  },
} as const;

/** Normalize loose input (ids as strings, or partial specs) into ModelSpec[]. */
export function normalizeModels(input: unknown): ModelSpec[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((m): ModelSpec | null => {
      if (typeof m === "string") return m.trim() ? { id: m.trim() } : null;
      if (m && typeof m === "object" && typeof (m as ModelSpec).id === "string") {
        const spec = m as ModelSpec;
        const caps = Array.isArray(spec.capabilities)
          ? spec.capabilities.filter((c): c is Capability => (CAPABILITIES as readonly string[]).includes(c))
          : undefined;
        return {
          id: spec.id.trim(),
          ...(spec.name ? { name: spec.name } : {}),
          ...(typeof spec.contextLength === "number" ? { contextLength: spec.contextLength } : {}),
          ...(caps && caps.length ? { capabilities: caps } : {}),
        };
      }
      return null;
    })
    .filter((m): m is ModelSpec => m !== null && m.id.length > 0);
}

/** Validate a per-request price: a positive whole number of the token's
 *  smallest unit, returned as a decimal string (the x402 `amount`). Rejects
 *  decimals rather than guessing, so "0.002" (meant as USDCx) can't silently
 *  become a different price. */
export function normalizePricePerRequest(input: unknown, token: PayoutToken): string {
  const unit = token === "sBTC" ? "sats" : "0.000001 USDCx units (0.002 USDCx = 2000)";
  if (input == null || input === "") throw new Error(`pricePerRequest is required — your price per request in ${unit}`);
  const raw = String(input).trim();
  if (!/^[0-9]+$/.test(raw)) throw new Error(`pricePerRequest must be a whole number of ${unit}`);
  const v = BigInt(raw);
  if (v < 1n) throw new Error("pricePerRequest must be at least 1");
  return v.toString();
}
