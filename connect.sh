#!/usr/bin/env bash
#
# Inference Marketplace — one-command provider connect.
#
# Puts your LOCAL model behind a shared key, exposes it over a public HTTPS
# tunnel, and registers it. Only the marketplace can call it (no bypass).
# Keep this running to stay online; Ctrl+C goes offline.
#
#   ./connect.sh
#   PORT=11434 NAME="My Qwen node" WALLET=SP... MODELS=qwen2.5-7b ./connect.sh
#
set -euo pipefail

GATEWAY="${GATEWAY:-http://localhost:8787}"
PORT="${PORT:-}"
NAME="${NAME:-}"
WALLET="${WALLET:-}"
MODELS="${MODELS:-}"
PROXY_PORT="${PROXY_PORT:-8799}"
DIR="$(cd "$(dirname "$0")" && pwd)"

ask() { local v; read -r -p "$1" v; printf '%s' "$v"; }
[ -z "$PORT" ]   && { PORT="$(ask 'Local model port [11434]: ')"; PORT="${PORT:-11434}"; }
[ -z "$NAME" ]   && NAME="$(ask 'Provider name: ')"
[ -z "$WALLET" ] && WALLET="$(ask 'Payout wallet (SP...): ')"
[ -z "$MODELS" ] && MODELS="$(ask 'Model ids (comma-separated): ')"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "→ Installing cloudflared…"
  if command -v brew >/dev/null 2>&1; then brew install cloudflared
  else echo "  Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"; exit 1; fi
fi

# 1) shared key + auth proxy in front of your model
KEY="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | xxd -p | tr -d '\n')"
echo "→ Securing your model with a shared key (only the marketplace can call it)…"
PROXY_KEY="$KEY" PROXY_PORT="$PROXY_PORT" UPSTREAM="http://localhost:${PORT}" node "$DIR/provider-proxy.mjs" &
PROXY_PID=$!

# 2) tunnel the PROXY (not the bare model)
echo "→ Opening a public tunnel…"
LOG="$(mktemp)"
cloudflared tunnel --url "http://localhost:${PROXY_PORT}" >"$LOG" 2>&1 &
TUNNEL_PID=$!
trap 'kill $TUNNEL_PID $PROXY_PID 2>/dev/null || true' EXIT

URL=""
for _ in $(seq 1 30); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break; sleep 1
done
[ -z "$URL" ] && { echo "✗ Couldn't get a tunnel URL:"; cat "$LOG"; exit 1; }
echo "→ Public URL: ${URL}"

# 3) wait until it routes (WITH the key — direct calls 401)
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
  echo "✅ Live & secured. Endpoint: ${URL}/v1 — direct calls without the key get 401."
else
  echo "✗ Registration failed: $RESP"; exit 1
fi

echo
echo "Keep this terminal open to stay online. Press Ctrl+C to go offline."
wait "$TUNNEL_PID"
