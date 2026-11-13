-- #1655: the per-minute queue sweeps (failExpiredOfflineWaits, runDueOverloadRetries) and
-- clearUnresponsiveBackoff select PENDING entries by defer_reason across instances, which neither
-- (instance_id, repo_id, status, created_at) nor (user_id, created_at, id) can do: each call read the
-- whole table (~4,590 rows). Partial over pending entries only; next_retry_at lets the retry sweep
-- skip entries whose backoff has not elapsed.
CREATE INDEX IF NOT EXISTS idx_instance_objective_queue_pending_defer
  ON instance_objective_queue(defer_reason, next_retry_at) WHERE status = 'pending';
