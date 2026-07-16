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
  // Payout address prefix follows the network: ST/SN on testnet, SP/SM on mainnet.
  const walletEx = network === 'mainnet' ? 'SP...' : 'ST...';
  const walletPrefixes = network === 'mainnet' ? '`SP…` / `SM…`' : '`ST…` / `SN…`';

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

**Fees — you keep 92%.** Registering and earning are free (no listing fee, no
bond). Each paid request settles on-chain, non-custodial: **92% → your payout
wallet**, **8% → the model's legion treasury**. The gateway never holds funds.

### Don't have a model hosted yet?
Any OpenAI-compatible server works (vLLM / Ollama / SGLang / HF Inference Endpoint).
Quickest local setup — an agent can run this for you:
\`\`\`
ollama serve &                 # OpenAI-compatible API on :11434
ollama pull qwen2.5:7b         # any open model
# Ollama rejects non-local Host headers, so rewrite it when tunneling:
cloudflared tunnel --url http://localhost:11434 --http-host-header localhost:11434
\`\`\`
The tunnel prints an \`https://….trycloudflare.com\` URL; your endpoint is that URL + \`/v1\`.
Use a named cloudflared tunnel for a stable URL that survives restarts.

### Register — one signed request
Ownership is proven by a **wallet signature**: you sign a short message with the
Stacks wallet whose address is your \`payoutAddress\`. The gateway stores the
endpoint only if the signature recovers to that address (this also enforces the
network — a wrong-network wallet is rejected). No accounts, no stored secrets.

**One step — AIBTC MCP agents.** \`inference_register_provider\` signs the message
with your unlocked wallet and POSTs it in a single call (do the manual steps below
only if you're not on the AIBTC MCP):
\`\`\`
inference_register_provider({
  name: "My node",
  endpoint: "https://my-host/v1",
  models: ["Qwen/Qwen2.5-7B-Instruct"],
  gateway: "${origin}"     // payoutAddress defaults to your unlocked wallet
})
\`\`\`

**1. Build the exact message** — \`Provider\` is the endpoint URL you'll register, \`Timestamp\` is the current unix time in seconds:
\`\`\`
Inference Marketplace
Action: register
Provider: https://my-host/v1
Timestamp: 1782980300
\`\`\`

**2. Sign it.**
- AIBTC MCP agents: \`stacks_sign_message({ message })\` → returns the RSV \`signature\`; read your compressed \`publicKey\` and ${network} address from \`get_wallet_info\`.
- Humans: use ${origin}/dashboard (connect wallet → Register → sign) — it does steps 1–3 for you.

**3. POST with the signature headers** (the timestamp header must equal the one in the signed message):
\`\`\`
curl -X POST ${origin}/v1/providers \\
  -H 'Content-Type: application/json' \\
  -H 'X-Stacks-Signature: <signature>' \\
  -H 'X-Stacks-Public-Key: <publicKey>' \\
  -H 'X-Stacks-Timestamp: 1782980300' \\
  -d '{
    "name": "My node",
    "endpoint": "https://my-host/v1",
    "payoutAddress": "${walletEx}",
    "models": ["Qwen/Qwen2.5-7B-Instruct"]
  }'
\`\`\`
- \`payoutAddress\` **must equal the signer's address** and be a ${network} address (${walletPrefixes}).
- \`models\` are **Hugging Face repo ids** — validated as real, text-generation, and commercially licensed (made-up / non-commercial ids rejected).
- \`Timestamp\` must be within **300s** of now; each signature is **single-use** (replay-protected).
- On success your node is verified, listed, and immediately callable.

Prefer a manifest? Host a \`schema.json\` (matching \`GET ${origin}/v1/schema\`) at
\`{endpoint}/schema.json\` and send a signed \`{"endpoint":"https://my-host/v1","payoutAddress":"${walletEx}"}\`.

### Manage your listing (same wallet signature)
AIBTC MCP agents manage in one call: \`inference_update_provider({ providerId, … })\`
to change any field, \`inference_reveal_key({ providerId, rotate })\` to reveal/rotate
the shared key, and \`inference_list_providers()\` / \`inference_check_provider({ providerId })\`
to find your id and re-probe health.

The manual equivalent: change name, models, payout, or endpoint in place — no
delete/re-add. Sign a message with \`Action: update\` and \`Provider: <yourProviderId>\`
(the id, **not** the endpoint), then PATCH with the same three headers:
\`\`\`
# signed message:
#   Inference Marketplace
#   Action: update
#   Provider: <yourProviderId>
#   Timestamp: <now>
curl -X PATCH ${origin}/v1/providers/<id> \\
  -H 'Content-Type: application/json' \\
  -H 'X-Stacks-Signature: <sig>' -H 'X-Stacks-Public-Key: <pub>' -H 'X-Stacks-Timestamp: <ts>' \\
  -d '{"payoutAddress":"${walletEx}"}'
\`\`\`
Reveal or rotate your shared key the same way with \`Action: reveal-key\` against
\`POST /v1/providers/{id}/key\` (send \`{"rotate":true}\` to issue a new one). Humans
do all of this at ${origin}/dashboard.

### Protect your endpoint (optional)
An open endpoint is public — anyone with the URL can call your model for free,
skipping payment. To require payment, lock it so only the gateway can reach it:
register with an \`apiKey\` your endpoint enforces (the gateway presents it on
every call), or \`rotate\` a gateway key and require it via a proxy / Cloudflare
Access. The shared key is **only** this gateway↔endpoint credential — never an
ownership token (that is your wallet signature).

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
  \`GET /v1/providers\`. A flagged provider never serves traffic. **Note:** \`flagged\` and
  \`flagReason\` are omitted from the response entirely when false/unset — a missing
  \`flagged\` key means "not flagged," not "field unsupported." There is currently no
  \`jobsOk\`/\`jobsFail\` (or similar per-job success counter) on this record; \`reputation\`
  is the only job-outcome-adjacent field, and it stays \`null\` until Phase 3 feedback wiring
  lands.
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
| POST | \`/v1/providers\` | free | Register a provider (**wallet-signature** required; verified before listing) |
| PATCH | \`/v1/providers/{id}\` | free | Self-service update (name/models/payout/endpoint); **wallet-signature** authorized |
| POST | \`/v1/providers/{id}/key\` | free | Reveal or rotate your shared key; **wallet-signature** authorized |
| POST | \`/v1/providers/{id}/flag\` | free | **Operator only** (admin token): flag/unflag a provider (de-route) |
`;
}
