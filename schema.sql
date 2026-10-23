-- Provider directory (D1). Apply locally:
--   npx wrangler d1 execute DB --local --file=schema.sql
-- and remotely (after `wrangler d1 create inference-db`):
--   npx wrangler d1 execute DB --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS providers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  endpoint      TEXT NOT NULL UNIQUE,
  api           TEXT NOT NULL DEFAULT 'openai-chat',
  payout_address TEXT NOT NULL,
  -- Payment token this provider is paid in: 'sBTC' or 'USDCx'. Clients must pay
  -- in this token (the 402 advertises only it). Existing DBs: run the ALTER below.
  --   ALTER TABLE providers ADD COLUMN accepted_token TEXT NOT NULL DEFAULT 'sBTC';
  accepted_token TEXT NOT NULL DEFAULT 'sBTC',
  -- Flat price per request in the smallest unit of accepted_token (sats for
  -- sBTC, 0.000001 USDCx for USDCx), as a decimal string — the x402 amount.
  -- NULL only on rows from before per-request pricing (not routed). Existing DBs:
  --   ALTER TABLE providers ADD COLUMN price_per_request TEXT;
  price_per_request TEXT,
  description   TEXT,
  secured       INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',
  flagged       INTEGER NOT NULL DEFAULT 0,
  flag_reason   TEXT,
  health        TEXT,          -- JSON HealthResult, null until first check
  -- checkedAt of the first failed check in the current outage; NULL while up.
  -- Hidden from GET /v1/providers after 24 h, deleted by the cron after 7 d. Existing DBs:
  --   ALTER TABLE providers ADD COLUMN down_since TEXT;
  down_since    TEXT,
  models        TEXT NOT NULL, -- JSON array of ModelSpec
  reputation    TEXT,          -- JSON { agentId, score? }, null until feedback
  registered_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_providers_payout ON providers(payout_address);

-- Shared secrets kept out of the provider row so they're never selected into a
-- client response.
CREATE TABLE IF NOT EXISTS provider_keys (
  id         TEXT PRIMARY KEY,
  shared_key TEXT NOT NULL
);
