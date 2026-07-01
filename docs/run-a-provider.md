# Run a provider

Serve an open model, get paid per request in sBTC. Your endpoint is always kept
behind a shared key, so only the marketplace can call it (direct calls 401).

> **Fees — you keep 92%.** Registering and joining are free (no listing fee, no
> bond required to earn). Each paid request settles **on-chain and
> non-custodial**: **92% goes straight to your payout wallet** and an **8%** fee
> routes to the model's legion treasury. The marketplace never holds your funds.

Pick the path that fits how your model is hosted.

---

## A. Quick start — temporary (good for a demo)

One command. No Cloudflare account, no domain.

```bash
curl -fsSL https://<gateway>/connect.sh | \
  NAME="My node" WALLET=SP... MODELS=Qwen/Qwen2.5-7B-Instruct PORT=11434 GATEWAY=https://<gateway> bash
```

What it does: starts a keyed proxy in front of your model → opens an anonymous
Cloudflare **quick tunnel** → registers it.

> ⚠️ **Temporary.** The `*.trycloudflare.com` URL **changes every time the
> process restarts** (Ctrl+C, reboot, sleep, crash) and caps at **~200
> concurrent requests**. Fine for a demo; not for a real node. Use **B** for a
> stable URL.

---

## B. Stable — a named tunnel on your Cloudflare account (recommended)

A permanent URL that survives restarts. Needs a free Cloudflare account **and a
domain added to it**.

**One-time setup:**

```bash
# 1. install the connector
brew install cloudflared            # macOS  (see CF docs for other OSes)

# 2. log in (opens a browser — pick your domain)
cloudflared tunnel login

# 3. create a named tunnel
cloudflared tunnel create my-node

# 4. point a hostname at it (creates the DNS record)
cloudflared tunnel route dns my-node node.yourdomain.com
```

**Run it** (keyed proxy + your named tunnel + auto-register):

```bash
TUNNEL=my-node HOST=node.yourdomain.com \
  NAME="My node" WALLET=SP... MODELS=Qwen/Qwen2.5-7B-Instruct PORT=11434 GATEWAY=https://<gateway> \
  ./connect.sh
```

Your stable URL is `https://node.yourdomain.com/v1`. It stays the same across
restarts.

**Survive reboots** (run as a background service): install cloudflared as a
service (`cloudflared service install`) and run the keyed proxy under your init
system (systemd / launchd) so both come back automatically.

---

## C. Already on a public server

If your model already has a public `https://…/v1` URL (your own auth or x402),
just register it in the dashboard's **Already public** tab — paste the URL (and
the API key if it's protected). We verify it's reachable + actually serving, then
list it.

---

## Notes

- **Models** are the ids agents request (e.g. `Qwen/Qwen2.5-7B-Instruct`). Use ids from the
  catalog so clients find you.
- **Payout wallet** (`SP…`) is where sBTC lands — payment settles to you directly.
- The marketplace **never manages your tunnel** and **never sees your model
  except through the keyed endpoint**. The key is stored server-side and never
  returned to clients.
