-- #1659: auto_pickup_log was indexed only by (instance_id, created_at) and (user_id, created_at, id), so
-- three per-wake lookups read every log row of the instance and filtered.

-- pendingAutoPickupAdmission now starts from the instance's PENDING queue entries (usually none) and
-- finds the log row by its entry.
CREATE INDEX IF NOT EXISTS idx_instance_objective_queue_pending_instance
  ON instance_objective_queue(instance_id, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_auto_pickup_log_entry
  ON auto_pickup_log(entry_id) WHERE entry_id IS NOT NULL;

-- recoverReservations: reservations a crash left behind. Almost always empty.
CREATE INDEX IF NOT EXISTS idx_auto_pickup_log_reserved
  ON auto_pickup_log(instance_id, created_at) WHERE reserved = 1;

-- "was this issue already skipped as failed" probe in the pickup wake.
CREATE INDEX IF NOT EXISTS idx_auto_pickup_log_skipped_failed
  ON auto_pickup_log(instance_id, repo, issue_number) WHERE outcome = 'skipped_failed';
