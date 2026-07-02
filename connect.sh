#!/usr/bin/env bash
#
# Inference Marketplace — one-command provider connect (self-contained).
#
# Puts your LOCAL model behind a shared key, opens a public tunnel, and
# registers it. Only the marketplace can call it (no bypass). Keep running to
# stay online; Ctrl+C goes offline.
#
#   curl -fsSL https://<gateway>/connect.sh | NAME="My node" WALLET=ST... MODELS=Qwen/Qwen2.5-7B-Instruct GATEWAY=https://<gateway> bash
#   # or, from a checkout:
#   NAME="My node" WALLET=ST... MODELS=Qwen/Qwen2.5-7B-Instruct ./connect.sh
#
set -euo pipefail

GATEWAY="${GATEWAY:-http://localhost:8787}"
PORT="${PORT:-11434}"
PROXY_PORT="${PROXY_PORT:-8799}"
NAME="${NAME:-}"
WALLET="${WALLET:-}"
MODELS="${MODELS:-}"

ask() { local v; read -r -p "$1" v; printf '%s' "$v"; }
[ -z "$NAME" ]   && NAME="$(ask 'Provider name: ')"
[ -z "$WALLET" ] && WALLET="$(ask 'Payout wallet (ST... testnet): ')"
[ -z "$MODELS" ] && MODELS="$(ask 'HF model ids (e.g. Qwen/Qwen2.5-7B-Instruct): ')"

command -v cloudflared >/dev/null 2>&1 || {
  echo "→ Installing cloudflared…"
  if command -v brew >/dev/null 2>&1; then brew install cloudflared
  else echo "  Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"; exit 1; fi
}

# 1) shared key + keyed auth proxy in front of the local model (no bypass)
KEY="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | xxd -p | tr -d '\n')"
cat > /tmp/mkt-proxy.mjs <<'PROXY'
import { createServer, request } from 'node:http';
const KEY = process.env.PROXY_KEY, UP = new URL(process.env.UPSTREAM);
createServer((req, res) => {
  if ((req.headers.authorization || '') !== 'Bearer ' + KEY) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
  const h = Object.assign({}, req.headers, { host: UP.host }); delete h.authorization;
  const up = request({ hostname: UP.hostname, port: UP.port || 80, path: req.url, method: req.method, headers: h }, (u) => { res.writeHead(u.statusCode || 502, u.headers); u.pipe(res); });
  up.on('error', (e) => { res.writeHead(502); res.end(String(e)); }); req.pipe(up);
}).listen(Number(process.env.PROXY_PORT || 8799));
PROXY
echo "→ Securing your model with a shared key…"
PROXY_KEY="$KEY" PROXY_PORT="$PROXY_PORT" UPSTREAM="http://localhost:${PORT}" node /tmp/mkt-proxy.mjs &
PROXY_PID=$!

# 2) tunnel the proxy
LOG="$(mktemp)"
STABLE=0
if [ -n "${TUNNEL:-}" ] && [ -n "${HOST:-}" ]; then
  # Stable mode: a NAMED tunnel you already created (cloudflared tunnel create/route).
  echo "→ Starting your named tunnel '${TUNNEL}' (stable URL)…"
  cloudflared tunnel run --url "http://localhost:${PROXY_PORT}" "$TUNNEL" >"$LOG" 2>&1 &
  TUNNEL_PID=$!
  URL="https://${HOST}"; STABLE=1
else
  # Quick mode: an anonymous temporary tunnel (dev-grade).
  echo "→ Opening a temporary public tunnel…"
  cloudflared tunnel --url "http://localhost:${PROXY_PORT}" >"$LOG" 2>&1 &
  TUNNEL_PID=$!
  URL=""
  for _ in $(seq 1 30); do URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"; [ -n "$URL" ] && break; sleep 1; done
  [ -z "$URL" ] && { echo "✗ Couldn't get a tunnel URL:"; cat "$LOG"; exit 1; }
fi
trap 'kill $TUNNEL_PID $PROXY_PID 2>/dev/null || true' EXIT
echo "→ Public URL: ${URL}"

# 3) wait until it routes (with the key — direct calls 401)
echo "→ Waiting for it to come online…"
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 -H "Authorization: Bearer ${KEY}" "${URL}/v1/models" 2>/dev/null || true)"
  [ "$code" = "200" ] && break; sleep 2
done

# 4) register (key stored server-side, never shown to clients)
echo "→ Registering on the marketplace…"
MODELS_JSON="$(printf '%s' "$MODELS" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep . | sed 's/.*/{"id":"&"}/' | paste -sd, -)"
RESP="$(curl -s -X POST "${GATEWAY}/v1/providers" -H 'Content-Type: application/json' \
  -d "{\"name\":\"${NAME}\",\"endpoint\":\"${URL}/v1\",\"payoutAddress\":\"${WALLET}\",\"apiKey\":\"${KEY}\",\"models\":[${MODELS_JSON}]}")"

if printf '%s' "$RESP" | grep -q '"provider"'; then
  PID="$(printf '%s' "$RESP" | grep -oE '"id":"[^"]+"' | head -1 | sed 's/"id":"//;s/"$//')"
  # Save credentials locally — the only copy you can read back later (the gateway
  # stores the key write-only). umask 077 → dir 700, file 600, so only you can read it.
  CRED_DIR="${HOME}/.inference-marketplace"; CRED_FILE="${CRED_DIR}/${PID:-provider}.env"
  ( umask 077; mkdir -p "$CRED_DIR" && cat > "$CRED_FILE" <<CRED
PROVIDER_ID=${PID}
SHARED_KEY=${KEY}
GATEWAY=${GATEWAY}
ENDPOINT=${URL}/v1
CRED
  ) 2>/dev/null && SAVED="$CRED_FILE" || SAVED=""
  echo "✅ Live & secured — direct calls without the key get 401. Keep this open to stay online (Ctrl+C to stop)."
  echo
  echo "   Provider id:  ${PID}"
  echo "   Shared key:   ${KEY}"
  [ -n "$SAVED" ] && echo "   Saved to:     ${SAVED}"
  echo "   ↑ keep the key secret — it's how you (and only you) update this listing."
  echo "   Update name/models/payout without deleting & re-adding:"
  echo "     curl -X PATCH ${GATEWAY}/v1/providers/${PID} \\"
  echo "       -H \"Authorization: Bearer ${KEY}\" -H 'Content-Type: application/json' \\"
  echo "       -d '{\"payoutAddress\":\"${WALLET}\"}'"
  if [ "$STABLE" = 0 ]; then
    echo
    echo "⚠️  TEMPORARY quick tunnel (dev-grade): the URL changes on restart and caps at ~200"
    echo "   concurrent requests. For a permanent URL, set up a named tunnel — see"
    echo "   docs/run-a-provider.md (then re-run with TUNNEL=… HOST=…)."
  fi
else
  echo "✗ Registration failed: $RESP"; exit 1
fi

wait "$TUNNEL_PID"
