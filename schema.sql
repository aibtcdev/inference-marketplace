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
  description   TEXT,
  secured       INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',
  flagged       INTEGER NOT NULL DEFAULT 0,
  flag_reason   TEXT,
  health        TEXT,          -- JSON HealthResult, null until first check
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
