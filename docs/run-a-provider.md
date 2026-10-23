# Run a provider

Serve an open model, get paid per request in sBTC. You need two things:

1. An **OpenAI-compatible endpoint** (vLLM / Ollama / SGLang / HF Inference Endpoint / …).
2. A **Stacks wallet** — its address is your payout address, and signing with it is how you prove ownership (no accounts, no passwords).

> **Fees — you keep 92%.** Registering and joining are free (no listing fee, no
> bond). Each paid request settles **on-chain and non-custodial**: **92% goes
> straight to your payout wallet**, an **8%** fee routes to the model's legion
> treasury. The marketplace never holds your funds.

Your endpoint is **open by default** — anyone with the URL can call it. That's
fine to start; when you want to force all traffic through the paid gateway, see
[Protect your endpoint](#protect-your-endpoint).

---

## Two ways to list

### A. Web — [inference.aibtc.com](https://inference.aibtc.com)
Connect your wallet (on the gateway's network — testnet today), click **Register
endpoint**, fill in the endpoint URL + model, and **sign** the message the wallet
pops up. That signature proves you own the payout wallet. Manage everything after
at **`/dashboard`**.

Don't have a model hosted yet? Open the **Running locally** tab — it gives you a
copyable prompt to paste into **Claude Code** (or any AI agent with the AIBTC
MCP) that hosts the model, tunnels it, and registers it for you.

### B. AI agent — Claude Code + the AIBTC MCP
Just ask it. With the AIBTC MCP connected, an agent can do the whole thing:
stand up a model, expose it, sign the registration with your wallet, and post it.
A prompt like:

> List my local model on the AIBTC Inference Marketplace and get me paid in sBTC.
> Host `qwen2.5:7b` with Ollama, tunnel it, and register the endpoint using my
> Stacks wallet.

The agent signs with `stacks_sign_message` and registers — see
[Registering](#registering-the-signed-request) for exactly what it sends.

---

## Don't have a model hosted yet?

Any OpenAI-compatible server works. Quickest local setup (an agent can run this):

```bash
ollama serve &                 # OpenAI-compatible API on :11434
ollama pull qwen2.5:7b         # any open model

# Expose it. Ollama rejects non-local Host headers, so rewrite it:
cloudflared tunnel --url http://localhost:11434 --http-host-header localhost:11434
```

The tunnel prints an `https://….trycloudflare.com` URL; your endpoint is that URL
+ `/v1`. For a **stable** URL that survives restarts, use a **named** cloudflared
tunnel (`cloudflared tunnel create` + `route dns`) and run it with the same
`--http-host-header localhost:11434` flag.

---

## Registering (the signed request)

Registration requires a **payout-wallet signature**. The gateway stores your
endpoint only if the signature recovers to the `payoutAddress` you send — which
also enforces the network (a mainnet wallet is rejected on a testnet gateway).

**1. Build the exact message** (`Provider` = the endpoint URL you'll send;
`Timestamp` = current unix seconds):

```
Inference Marketplace
Action: register
Provider: https://my-host/v1
Timestamp: 1782980300
```

**2. Sign it** with your wallet. With the AIBTC MCP: `stacks_sign_message({ message })`
returns the RSV `signature`; read your compressed `publicKey` and testnet address
from `get_wallet_info`. In the browser, the dashboard does this for you.

**3. POST it** with the signature headers:

```bash
curl -X POST https://<gateway>/v1/providers \
  -H 'Content-Type: application/json' \
  -H 'X-Stacks-Signature: <signature>' \
  -H 'X-Stacks-Public-Key: <publicKey>' \
  -H 'X-Stacks-Timestamp: 1782980300' \
  -d '{
    "name": "My node",
    "endpoint": "https://my-host/v1",
    "payoutAddress": "ST...",
    "acceptedToken": "sBTC",
    "pricePerRequest": "5",
    "models": ["Qwen/Qwen2.5-7B-Instruct"]
  }'
```

- `payoutAddress` **must equal the signer's address** and be a testnet `ST…`/`SN…` address.
- `pricePerRequest` (**required**) is your flat price per request in the token you're paid in (`acceptedToken`), as a whole number of its smallest unit: **sats** for sBTC (`"5"` = 5 sats), **0.000001 USDCx** for USDCx (`"2000"` = 0.002 USDCx). Clients pay exactly this per call.
- `models` are **Hugging Face repo ids** — validated as real, text-generation, and commercially licensed (made-up / non-commercial ids are rejected).
- `Timestamp` must be within **300s** of now; each signature is **single-use** (replay-protected).
- The gateway verifies your endpoint is reachable **and** actually serving inference before listing it.

Prefer a manifest? Host a `schema.json` (matching `GET https://<gateway>/v1/schema`)
at `{endpoint}/schema.json` and send a signed `{"endpoint":"…","payoutAddress":"…"}`.

---

## Manage your listing

Change name, models, payout, price, or endpoint **in place** — no delete/re-add, and no
shared key to remember. Everything is authorized by the same wallet signature.

- **Web:** `/dashboard` — connect wallet, edit, sign.
- **Agent / curl:** sign a message with `Action: update` and `Provider: <yourProviderId>`
  (the id, **not** the endpoint), then `PATCH /v1/providers/{id}` with the three
  `X-Stacks-*` headers.

```bash
# signed message: "Inference Marketplace\nAction: update\nProvider: <id>\nTimestamp: <now>"
curl -X PATCH https://<gateway>/v1/providers/<id> \
  -H 'X-Stacks-Signature: <sig>' -H 'X-Stacks-Public-Key: <pub>' -H 'X-Stacks-Timestamp: <ts>' \
  -H 'Content-Type: application/json' \
  -d '{"payoutAddress":"ST...","models":[{"id":"Qwen/Qwen2.5-7B-Instruct"}]}'
```

Changing the endpoint re-verifies reachability before it takes effect, so a bad
edit can't knock you offline.

---

## Protect your endpoint

An open endpoint is public: anyone with the URL can use your model for free,
skipping payment. To require payment, lock it so only the gateway can call it.
Two ways:

- **Your endpoint already needs an API key** — include it as `apiKey` when you
  register (or add it later via Edit). The gateway presents it on every call, so
  direct callers without it are rejected.
- **No auth of its own** — from `/dashboard`, **rotate** a gateway key, then put a
  reverse proxy (or Cloudflare Access) in front of your endpoint that requires
  `Authorization: Bearer <key>`.

Reveal or rotate the key from `/dashboard`, or via `POST /v1/providers/{id}/key`
with a wallet signature (`Action: reveal-key`; body `{"rotate":true}` to issue a
new one). The gateway stores the key **write-only** — the only way to read it back
is a wallet signature.

The shared key is **only** this gateway↔endpoint credential. It is **not** an
ownership token — ownership is always your wallet signature.

---

## Notes

- **Models** are Hugging Face repo ids (e.g. `Qwen/Qwen2.5-7B-Instruct`). Use ids from the catalog so clients find you.
- **Payout wallet** (`ST…` on testnet) is where sBTC lands — payment settles to you directly, non-custodially.
- The marketplace **never manages your tunnel** and **never sees your model except through your endpoint**.
- Keep your endpoint (and tunnel) running to stay listed; health checks de-route an endpoint that goes down and re-route it when it returns.
