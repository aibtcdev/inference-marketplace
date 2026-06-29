/**
 * Agent skill manifest — served as markdown at `GET /skill.md`.
 *
 * One self-describing document an agent (or human) can fetch and act on in a
 * single step: how to (A) pay per request and call inference, and (B) list a
 * model and get paid. Generated from live state (origin, network, the actual
 * catalog + registered providers) so the snippets are always correct and the
 * model ids are real and callable right now.
 */

import { MODELS, DEFAULT_MODEL } from './catalog';
import type { Provider } from './directory';

export interface SkillContext {
  origin: string;
  network: string;
  providers: Provider[];
  defaultPricePerMTok: number;
}

function modelsTable(providers: Provider[]): string {
  const rows: string[] = [];
  for (const m of MODELS) {
    rows.push(`| \`${m.id}\` | house | ${m.tier} | ${m.contextLength.toLocaleString()} | live |`);
  }
  for (const p of providers) {
    if (p.status === 'down') continue;
    for (const m of p.models) {
      const ctx = m.contextLength ? m.contextLength.toLocaleString() : '—';
      rows.push(`| \`${m.id}\` | ${p.id} | community | ${ctx} | ${p.status} |`);
    }
  }
  return [
    '| Model | Provider | Source | Context | Status |',
    '|-------|----------|--------|---------|--------|',
    ...rows,
  ].join('\n');
}

export function renderSkillMd(ctx: SkillContext): string {
  const { origin, network, providers, defaultPricePerMTok } = ctx;
  const example = DEFAULT_MODEL.id;

  return `# Inference Marketplace — Agent Skill

Pay-per-request AI inference, settled in Bitcoin (**sBTC**) on Stacks via
**x402**. Non-custodial: clients pay providers directly. This document is
machine- and human-readable — read it once and you can either **(A) call
inference and pay per request** or **(B) list your own model and get paid**.
Every model id below is real and callable right now; every price is live.

- **Base URL:** \`${origin}\`
- **Network:** \`${network}\`
- **Payment:** x402 v2 — tokens: \`sBTC\`, \`USDCx\`, \`STX\` (choose with header \`X-PAYMENT-TOKEN-TYPE\`)
- **Live catalog (JSON):** \`GET ${origin}/v1/models\`
- **Registration schema (JSON):** \`GET ${origin}/v1/schema\`

---

## A. Call inference (pay per request)

### One step — AIBTC MCP agents
\`execute_x402_endpoint\` probes the 402, signs the payment, settles via the
relay, and returns the completion:

\`\`\`
execute_x402_endpoint({
  url: "${origin}/v1/chat/completions",
  method: "POST",
  data: {
    model: "${example}",
    messages: [{ role: "user", content: "Hello" }]
  }
})
\`\`\`

### Manual — any OpenAI-compatible client
1. POST without payment — you get **HTTP 402** with the price, \`payTo\`, \`nonce\`, \`asset\`:
\`\`\`
curl -X POST ${origin}/v1/chat/completions \\
  -H 'Content-Type: application/json' \\
  -d '{"model":"${example}","messages":[{"role":"user","content":"Hello"}]}'
\`\`\`
2. Sign a token transfer to \`payTo\` — **do not broadcast**.
3. Retry with header \`payment-signature: <base64 PaymentPayloadV2>\`. The gateway
   settles and returns the completion. Each response carries a \`_marketplace\`
   receipt including the settlement \`txId\`.

To pay in a specific token, send \`X-PAYMENT-TOKEN-TYPE: sBTC\` (or \`USDCx\` / \`STX\`).

### Models
${modelsTable(providers)}

\`house\` models are served by the marketplace's own upstream; \`community\` models
are served by registered providers and settle directly to that provider's
wallet. Both are callable by model id on \`/v1/chat/completions\`; a community
model is also callable explicitly at \`POST ${origin}/v1/route/{providerId}/chat/completions\`.

---

## B. List your model (get paid in sBTC)

You run an OpenAI-compatible endpoint (vLLM / HF Inference Endpoint / Ollama /
SGLang / …). Register it; the marketplace verifies it is reachable **and**
actually serving inference, then wraps it in x402 so clients pay **you** directly.

### Already public — one request
\`\`\`
curl -X POST ${origin}/v1/providers \\
  -H 'Content-Type: application/json' \\
  -d '{
    "name": "My node",
    "endpoint": "https://my-host/v1",
    "payoutAddress": "SP...",
    "models": ["Qwen/Qwen2.5-7B-Instruct"],
    "apiKey": "optional-shared-key"
  }'
\`\`\`
- \`models\` are **Hugging Face repo ids** — validated as real, text-generation,
  and commercially licensed before listing (made-up or non-commercial ids are rejected).
- \`apiKey\` (optional) is stored server-side and **never returned**; the gateway
  forwards it, so direct calls without it are rejected.
- \`payoutAddress\` is a mainnet Stacks address (\`SP…\` / \`SM…\`).
- On success your node is listed and immediately callable.

You can instead host a \`schema.json\` (matching \`GET ${origin}/v1/schema\`) at
\`{endpoint}/schema.json\` and register with just \`{"endpoint":"https://my-host/v1"}\`.

### Running locally — one command
Secures your local model behind a shared key, opens a public tunnel, and registers it:
\`\`\`
curl -fsSL ${origin}/connect.sh | NAME="My node" WALLET=SP... MODELS=Qwen/Qwen2.5-7B-Instruct GATEWAY=${origin} bash
\`\`\`
Keep it running to stay online. For a stable URL, use a named tunnel (\`TUNNEL=\` / \`HOST=\`).

### Pricing
Declare \`pricePerMTokenUsd\` per model (USD per 1M tokens) in your registration;
the default is **$${defaultPricePerMTok}/Mtok**. The charged amount is converted to
the client's chosen token at the live spot rate, so your USD price stays stable.

---

## Enforcement & trust

How bad providers are handled, so you can trust the catalog:

- **Who enforces:** the **marketplace operator**. A provider can be **flagged**, which
  de-routes it everywhere and removes it from the catalog. Today this is a **manual operator
  action** via an admin-gated endpoint — there is **no automatic cheat-detection yet**, so a
  provider is flagged only when the operator acts on a complaint or review.
- **Transparency:** a provider's \`flagged\` status (and \`flagReason\`) is **public** in
  \`GET /v1/providers\`. A flagged provider never serves traffic.
- **You can report, not flag:** reporting a suspect provider signals the operator; only the
  operator turns a report into a flag. Flagging is **not** a crowd action.
- **Roadmap:** the flag decision is planned to move on-chain to a stake-weighted
  \`legion-gov\` vote (the legion decides, not the operator).

## Endpoints
| Method | Path | Cost | Purpose |
|--------|------|------|---------|
| GET | \`/\` | free | Service + payment info |
| GET | \`/skill.md\` | free | This document |
| GET | \`/v1/models\` | free | Live catalog (house + community) |
| GET | \`/v1/providers\` | free | Registered providers + health + \`flagged\` status |
| GET | \`/v1/schema\` | free | Provider registration JSON Schema |
| POST | \`/v1/chat/completions\` | **paid** | OpenAI-compatible; price by model + tokens |
| POST | \`/v1/route/{id}/chat/completions\` | **paid** | Call a specific provider; settles to them |
| POST | \`/v1/providers\` | free | Register a provider (verified before listing) |
| POST | \`/v1/providers/{id}/flag\` | free | **Operator only** (admin token): flag/unflag a provider (de-route) |
`;
}
