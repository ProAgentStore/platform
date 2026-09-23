-- A task-scoped capability for the subscription-backed Website Builder (#841).
--
-- The local Claude/Codex worker receives only a random job token. It never receives
-- the FWS OAuth credential or a general PAGS session token. The API keeps the selected
-- MCP endpoint and allows only draft-building FWS calls for this exact job.
CREATE TABLE IF NOT EXISTS website_builder_jobs (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  mcp_url TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  evidence TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_website_builder_jobs_instance
  ON website_builder_jobs(instance_id, user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_website_builder_jobs_idempotency
  ON website_builder_jobs(instance_id, idempotency_key);

-- Broker facts, not a CLI-provided assertion, are what make a draft eligible for review.
CREATE TABLE IF NOT EXISTS website_builder_job_calls (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  result TEXT NOT NULL,
  success INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_website_builder_job_calls_job
  ON website_builder_job_calls(job_id, created_at);
