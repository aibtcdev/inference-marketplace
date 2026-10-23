# AIBTC Inference Marketplace — Gateway

Pay-per-request AI inference, settled in **sBTC / USDCx** on Stacks. Anyone can
register their own OpenAI-compatible model endpoint; an agent pays for a single
call by signing a token transfer (x402); the AIBTC relay verifies it; the gateway
forwards the request to that provider and returns the completion.

**The marketplace runs no models of its own and takes no fee.** It is a directory
+ x402 paywall + trust layer. Payment settles **directly to the provider**
(non-custodial) — the gateway never holds funds. Each provider picks the token it
is paid in (**sBTC** or **USDCx**).

```
agent ──(1) request──────────────▶ gateway
agent ◀─(2) 402 + price/payTo───── gateway     payTo = the provider's wallet
agent ──(3) sign transfer (no broadcast)
agent ──(4) retry w/ X-PAYMENT───▶ gateway ──settle──▶ x402 relay ──▶ Stacks
                                   gateway ──inference─▶ provider's endpoint
agent ◀─(5) completion + receipt── gateway
```

## Supply side

A provider registers an OpenAI-compatible endpoint (vLLM / HF Inference Endpoint /
Ollama / SGLang / …) with a wallet-signed request. The gateway verifies the
endpoint is reachable and actually serving inference, checks the model ids against
Hugging Face (real, text-generation, commercially licensed), then lists it. From
then on clients can call it by model id and pay per request — **100% to the
provider's payout wallet**, in the provider's chosen token.

## Configuration

Non-secret config lives in `wrangler.jsonc`; there are no required secrets for the
marketplace itself (payment settles to each provider, so the gateway holds none).

| Name | Required | Purpose |
|------|----------|---------|
| `NETWORK` | ✅ | `mainnet` or `testnet` (selects token contracts, relay, Stacks API) |
| `RELAY_URL` | — | x402 settlement relay (defaults per network) |
| `STACKS_API` | — | Hiro API base (defaults per network) |
| `DB` (D1) | ✅ | Provider directory (`providers` + `provider_keys`) |
| `PROVIDERS` (KV) | ✅ | Ephemeral: wallet-auth replay nonces + stake cache |
| `ADMIN_TOKEN` | — | `X-Admin-Token` for the operator flag endpoint (required to flag on mainnet) |
| `SKIP_PAYMENT` | — | **Dev only.** `true` bypasses payment — hard-gated to non-mainnet |
| `LEGION_*` | — | Optional 8% fee rail (off by default; see [Fees](#fees)) |

## Endpoints

| Method | Path | Cost | Notes |
|--------|------|------|-------|
| GET | `/` | free | Service + payment info |
| GET | `/health` | free | Health check |
| GET | `/skill.md` | free | Agent skill manifest (read this first) |
| GET | `/v1/models` | free | Live catalog — every model from a registered provider + its per-request price |
| GET | `/v1/providers` | free | Registered providers + health + `flagged` status |
| GET | `/v1/schema` | free | Provider registration JSON Schema |
| POST | `/v1/chat/completions` | **paid** | OpenAI-compatible; routes to the model's provider |
| POST | `/v1/route/{id}/chat/completions` | **paid** | Call a specific provider; settles to them |
| POST | `/v1/providers` | free | Register a provider (**wallet-signature** required; verified before listing) |
| PATCH | `/v1/providers/{id}` | free | Self-service update (name/models/payout/token/endpoint); **wallet-signature** authorized |
| POST | `/v1/providers/{id}/key` | free | Reveal or rotate the provider's shared key; **wallet-signature** authorized |
| POST | `/v1/providers/{id}/flag` | free | **Operator only** (admin token): flag/unflag a provider |
| POST | `/v1/feedback` | free | Submit reputation (Phase 3) |

## Fees

**Providers keep 100%.** Registering and earning are free — no listing fee, no
bond required to earn. Each paid request settles **on-chain and non-custodial**
via the direct x402 `exact` scheme: **100% → the provider's payout wallet**, in
the token the provider chose (**sBTC** or **USDCx**). The gateway never custodies
funds.

> The 8% Legion fee rail (`legion-fees.route`) is disabled — it activates only
> when the `LEGION_*` vars are set (see `wrangler.jsonc`). Re-add them to bring
> back the 92/8 split and per-model legion treasuries.

## Enforcement & trust

- **Who enforces:** the **marketplace operator**. A provider can be **flagged**, which
  de-routes it everywhere and drops it from the catalog. Flagging is a **manual operator
  action** via `POST /v1/providers/{id}/flag`, gated by `ADMIN_TOKEN` (the `X-Admin-Token`
  header). It is **not** a key/multisig and **not** a crowd vote — it is the operator.
- **No auto-detection yet:** a provider is flagged only when the operator acts on a complaint
  or manual review. Agents/users can *report*; only the operator can *flag*.
- **Transparency:** `flagged` + `flagReason` are public on `GET /v1/providers`. A flagged
  provider never serves traffic and is excluded from routing and the catalog.
- **Mainnet safety:** the flag endpoint is disabled on mainnet unless `ADMIN_TOKEN` is set.
- **Roadmap:** move the flag decision on-chain to a stake-weighted `legion-gov` vote.

## Pricing

Each provider sets one flat **`pricePerRequest`** (required) in the token it is
paid in, as a whole number of that token's smallest unit: **sats** for sBTC
(`"5"` = 5 sats), **0.000001 USDCx** for USDCx (`"2000"` = 0.002 USDCx). The 402
asks for exactly that amount — no token estimate, no currency conversion, no
default. Each response carries a `_marketplace` receipt with the provider,
`paidTo`, and the settlement `txId`.

## x402 payment flow

1. Client POSTs without `payment-signature`.
2. Gateway replies **402** with the price, `payTo` (the provider), `asset`, and `nonce`.
   The advertised token is the one the provider chose.
3. Client signs a token transfer to `payTo` — **does not broadcast**.
4. Client retries with `payment-signature: <base64 PaymentPayloadV2>`.
5. Gateway settles via the AIBTC relay, then forwards the inference.

```bash
curl -X POST https://inference.aibtc.com/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"Qwen/Qwen2.5-7B-Instruct","messages":[{"role":"user","content":"Hello"}]}'
# -> 402 with the price + payTo for the provider serving this model
```

Agents on AIBTC pay automatically via `execute_x402_endpoint` (probe → sign → settle).

## Architecture

| File | Role |
|------|------|
| `src/index.ts` | Routes: discovery, paid inference, supply-side registration |
| `src/x402-middleware.ts` | x402 settlement (fixed + dynamic) via the AIBTC relay |
| `src/directory.ts` | Provider directory (D1): register / verify / update / flag |
| `src/schema.ts` | Registration contract + accepted payout tokens |
| `src/upstream.ts` | OpenAI-compatible client that forwards to a provider's endpoint |
| `src/health.ts` | Endpoint health + inference verification (cron) |
| `src/wallet-auth.ts` | Wallet-signature auth for provider self-service |
| `src/model-legions.ts` / `src/legion.ts` | Optional per-model fee rail + stake ranking |

## Deploy

```bash
wrangler login
# create + migrate the directory DB, then paste its id into wrangler.jsonc
wrangler d1 create inference-db-mainnet
wrangler d1 execute inference-db-mainnet --remote --file=schema.sql
npm run deploy:testnet       # testnet (gateway.*.workers.dev)
npm run deploy:staging       # testnet (gateway-staging)
npm run deploy:production    # mainnet (inference.aibtc.com) — also what a push to main deploys
```

## Networks

| Env | NETWORK | Relay |
|-----|---------|-------|
| default (production) | mainnet | `https://x402-relay.aibtc.com` |
| `testnet` / `staging` / dev | testnet | `https://x402-relay.aibtc.dev` |
