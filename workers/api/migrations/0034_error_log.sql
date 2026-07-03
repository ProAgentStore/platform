-- Durable error log. Failures that would otherwise be swallowed or only reach the
-- ephemeral worker logs (upstream key-proxy errors, Google/GitHub sign-in failures,
-- apply/coding workflow failures) are persisted here so they can be read back
-- (GET /v1/errors) instead of vanishing. One row per failure.
CREATE TABLE IF NOT EXISTS error_log (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id    TEXT,                 -- nullable: some failures have no user context
  source     TEXT NOT NULL,        -- 'keys-proxy' | 'auth' | 'job-apply' | ...
  status     INTEGER,              -- HTTP-ish status when applicable
  message    TEXT NOT NULL,        -- the failure reason
  context    TEXT                  -- JSON: { host, path, provider, instanceId, taskId, ... }
);
CREATE INDEX IF NOT EXISTS idx_error_log_user_time ON error_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_time ON error_log(created_at DESC);
