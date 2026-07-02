# AIBTC Inference Marketplace — Gateway

Pay-per-request AI inference, settled in **sBTC / USDCx** on Stacks. An agent
pays for a single inference call by signing a token transfer (x402); the AIBTC
relay verifies it; the gateway routes the request to an **open-weight model it
serves itself** and returns the completion.

> **Not an OpenRouter reseller.** Reselling a third-party API violates their
> terms (OpenRouter §7.4). Instead the gateway is a *real provider*: it serves
> open-weight models (Qwen, Llama, Mistral, DeepSeek) from its own
> OpenAI-compatible upstream — a **Hugging Face Inference Endpoint** or **vLLM**
> server. Serving open weights commercially is permitted by their licenses.

```
agent ──(1) request──────────────▶ gateway
agent ◀─(2) 402 + price/contract── gateway     price = serving_cost × markup → live sBTC
agent ──(3) sign transfer (no broadcast)
agent ──(4) retry w/ X-PAYMENT───▶ gateway ──settle──▶ x402 relay ──▶ Stacks
                                   gateway ──inference─▶ upstream (HF / vLLM, open model)
agent ◀─(5) completion + receipt── gateway
```

## Roadmap

| Phase | What | Status |
|------:|------|--------|
| **1** | You serve open models for sBTC/USDCx; AIBTC bridges Bitcoin↔inference | ✅ this repo |
| **2** | Open the supply side — anyone registers as a provider, gets paid in sBTC | 🔌 `POST /v1/providers`, `registry.ts` |
| **3** | Full marketplace — agents pick by reputation + price | 🔌 `POST /v1/feedback`, ERC-8004 `reputation_*` |

## Quick start

```bash
npm install
# .dev.vars: set RECIPIENT_ADDRESS, UPSTREAM_BASE_URL, UPSTREAM_API_KEY
npm run dev          # http://localhost:8787
```

No cloud GPU? Serve a model locally with Ollama (OpenAI-compatible):
```bash
ollama serve & ollama pull qwen2.5:7b
# UPSTREAM_BASE_URL=http://localhost:11434/v1  UPSTREAM_API_KEY=ollama  UPSTREAM_MODEL=qwen2.5:7b
```

## Configuration

| Name | Required | Purpose |
|------|----------|---------|
| `RECIPIENT_ADDRESS` | ✅ | Stacks address that receives payment |
| `UPSTREAM_BASE_URL` | ✅ | OpenAI-compatible upstream (HF Endpoint / vLLM), e.g. `https://xxxx.endpoints.huggingface.cloud/v1` |
| `UPSTREAM_API_KEY` | ✅ | Bearer token for the upstream |
| `PRICE_MARKUP` | — | Multiple of serving cost charged (default `1.5` = 50% margin) |
| `SKIP_PAYMENT` | — | **Dev only.** `true` bypasses payment — hard-gated to non-mainnet |

## Endpoints

| Method | Path | Cost | Notes |
|--------|------|------|-------|
| GET | `/` | free | Service + payment info |
| GET | `/health` | free | Health check |
| GET | `/v1/models` | free | Catalog + live reference price per model |
| GET | `/v1/providers` | free | Supply-side registry + reputation |
| POST | `/v1/chat/completions` | **dynamic** | OpenAI-compatible; price by model + tokens |
| POST | `/v1/chat` | fixed | Simple `{prompt}` demo, default model |
| POST | `/v1/providers` | free | Register an external provider (Phase 2) |
| PATCH | `/v1/providers/{id}` | free | Self-service update (name/models/payout/endpoint/key); auth with the provider's shared key as `Authorization: Bearer` |
| POST | `/v1/providers/{id}/flag` | free | **Operator only** (admin token): flag/unflag a provider |
| POST | `/v1/feedback` | free | Submit reputation (Phase 3) |

## Fees

**Providers keep 92%.** Registering and earning are free — no listing fee, no
bond required to earn. Each paid request settles **on-chain and non-custodial**
through the model's legion fee rail (`legion-fees.route`): **92% → the provider's
payout wallet**, **8% → the model's legion treasury**. The gateway never
custodies funds. Cheap calls are floored (`LEGION_MIN_AMOUNT`) so the 8% skim
always rounds to ≥1 base unit.

## Enforcement & trust

Be explicit about how bad providers are handled, so the catalog can be trusted:

- **Who enforces:** the **marketplace operator**. A provider can be **flagged**, which
  de-routes it everywhere and drops it from the catalog. Flagging is a **manual operator
  action** via `POST /v1/providers/{id}/flag`, gated by `ADMIN_TOKEN` (the `X-Admin-Token`
  header). It is **not** a key/multisig and **not** a crowd vote — it is the operator.
- **No auto-detection yet:** there is no automatic cheat-detection. A provider is flagged
  only when the operator acts on a complaint or manual review. Agents/users can *report*; only
  the operator can *flag*.
- **Transparency:** `flagged` + `flagReason` are public on `GET /v1/providers`. A flagged
  provider never serves traffic and is excluded from routing and the catalog.
- **Mainnet safety:** the flag endpoint is disabled on mainnet unless `ADMIN_TOKEN` is set.
- **Roadmap:** move the flag decision on-chain to a stake-weighted `legion-gov` vote (the
  legion decides, not the operator).

## Pricing (dynamic, two axes)

```
price_usd  = (prompt_tokens + max_tokens)/1000 × costPer1kUsd × markup
price_sats = ceil(price_usd / btc_usd × 1e8)        # 1-sat floor
```

1. **By model** — `costPer1kUsd` per model (your GPU $/hr ÷ throughput; tune in `catalog.ts`). Big models cost more.
2. **By market** — converted to sBTC/USDCx/STX at the **live** Coinbase rate, so the real (USD) price stays stable as BTC moves.

sBTC has a 1-sat floor (~$0.001); for sub-cent calls, **USDCx** (6 decimals) prices exactly. Each response carries a `_marketplace` receipt: `pricePaid` (USD + token units), `servingCostUsd`, and the settlement `txId` — so realized margin is visible per call.

> Phase 1.5: meter against actual usage (deposit → settle exact) to stop overcharging on short calls.

## x402 payment flow

1. Client POSTs without `X-PAYMENT`.
2. Gateway replies **402** with `{ maxAmountRequired, payTo, network, nonce, expiresAt, tokenType, tokenContract }`.
3. Client signs a token transfer to `payTo` — **does not broadcast**.
4. Client retries with `X-PAYMENT: <signed-tx>` (and optional `X-PAYMENT-TOKEN-TYPE: sBTC|USDCx|STX`).
5. Gateway settles via the AIBTC relay, then serves the inference.

```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen2.5-32b","messages":[{"role":"user","content":"Hello"}]}'
# -> 402 with the sBTC price for this model + token count
```

Agents on AIBTC pay automatically via `execute_x402_endpoint` (probe → sign → settle).

## Architecture

| File | Role |
|------|------|
| `src/index.ts` | Routes: discovery, paid inference, Phase 2/3 seams |
| `src/x402-middleware.ts` | x402 settlement (fixed + dynamic) via the AIBTC relay |
| `src/pricing.ts` | Dynamic pricing: serving cost × markup → live sBTC/USDCx/STX |
| `src/catalog.ts` | Open models: id ↔ upstream model + per-1k cost basis |
| `src/registry.ts` | Provider registry (supply side) + reputation hook |
| `src/upstream.ts` | OpenAI-compatible client (HF Endpoint / vLLM / any) |

## Hosting the model (the upstream)

Recommended first deployment:
- **Model:** an Apache-2.0 open weight, e.g. `Qwen/Qwen2.5-7B-Instruct`
- **Server:** vLLM or HF Inference Endpoint (both expose `/v1/chat/completions`)
- **Host:** HF Endpoint or RunPod **Serverless** (scale-to-zero → no idle GPU cost)
- Point `UPSTREAM_BASE_URL` at it, set the model's `upstreamModel` in `catalog.ts`.

## Deploy

```bash
wrangler login                          # no API token needed
wrangler secret put RECIPIENT_ADDRESS
wrangler secret put UPSTREAM_BASE_URL
wrangler secret put UPSTREAM_API_KEY
npm run deploy:staging                  # testnet relay
npm run deploy:production               # mainnet relay
```

## Networks

| Env | NETWORK | Relay |
|-----|---------|-------|
| dev / staging | testnet | `https://x402-relay.aibtc.dev` |
| production | mainnet | `https://x402-relay.aibtc.com` |
