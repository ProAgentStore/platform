-- #1644: auto-pickup's failure tally (failuresByIssue, auto-pickup.ts) read ~20,500 rows per call: it scanned every
-- run ever recorded to find one instance's failed queue-started runs, then listed every error row of the owner to
-- find the coding-session ones. Two partial indexes, each the size of what the query actually wants:
--
-- 1. The failed / needs-human runs a queue entry started, by instance. The query's own `status IN (...)` and its
--    join on queue_entry_id are what let SQLite prove this predicate, so the two must keep matching.
-- 2. The coding-session error rows, by owner (error_log is pruned at 30 days, so this stays small).
CREATE INDEX IF NOT EXISTS idx_agent_loop_runs_queue_failed
  ON agent_loop_runs(instance_id, finished_at) WHERE status IN ('failed', 'needs_human') AND queue_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_error_log_coding_session
  ON error_log(user_id) WHERE source = 'coding:session';
