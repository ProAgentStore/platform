-- Usage ledger: one row per BYOK AI call, recorded at the single choke point
-- (runUserWorkersAi). Powers the Usage page (tokens + estimated cost, by agent /
-- model / modality, over time). Cost is an ESTIMATE (BYOK — we never see the real
-- provider bill), stored as integer micros of USD (see lib/ai-pricing.ts). No
-- backfill: history begins the moment this ships.

CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT,               -- template id (nullable: some paths only know the instance)
  instance_id TEXT,            -- agent_instances.id when the call is instance-scoped
  provider TEXT NOT NULL,      -- 'anthropic' | 'cloudflare'
  model TEXT NOT NULL,         -- raw model id as sent to the provider
  kind TEXT NOT NULL,          -- chat | apply | coding | copilot | overseer | run | resume | translate | voice
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,   -- estimated USD micros (1e6 = $1)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The page always filters by (user, time window) then aggregates — this index
-- serves both the range scan and the ordering.
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_time
  ON ai_usage(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_usage_instance
  ON ai_usage(instance_id, created_at);
