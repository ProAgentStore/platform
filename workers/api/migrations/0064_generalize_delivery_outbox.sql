-- Generalize the delivery outbox so TRIGGERS reuse it instead of growing a second one (#17).
--
-- 0058 gave agent-to-agent connections at-least-once delivery: write-before-attempt, exponential
-- backoff, dead-lettering, idempotency, replay. Triggers got none of it — `lib/triggers.ts` has
-- no retry path at all, so a failed cron or webhook is simply lost.
--
-- That left the platform with TWO failure routes and DIFFERENT durability guarantees, which is
-- worse than neither having it: whether your automation survives a transient outage depends on
-- which edge happened to fire, and nothing in the UI says which. The original #17 asked for a
-- retry policy on triggers; building a second mechanism with its own backoff table and its own
-- dead-letter concept would have entrenched the split.
--
-- So: one row shape for any durable attempt. `source` says what kind of edge produced it and
-- `connection_id` becomes the generic source id (the connection, or the trigger). Existing rows
-- are all connections, which is exactly what the DEFAULT backfills — no data migration.
--
-- The column keeps its name on purpose: renaming it would touch every query and index for a
-- cosmetic gain, and SQLite rewrites the table to do it.

ALTER TABLE agent_connection_deliveries
  ADD COLUMN source TEXT NOT NULL DEFAULT 'connection';   -- 'connection' | 'trigger'

-- The due-work sweep is now shared by both kinds, so it stays one index scan. The existing
-- idx_conn_deliveries_due(status, next_attempt_at) already covers it; this one lets the console
-- and the replay path answer "what is stuck, of this kind" without a full scan.
CREATE INDEX IF NOT EXISTS idx_conn_deliveries_source
  ON agent_connection_deliveries(source, status, next_attempt_at);
