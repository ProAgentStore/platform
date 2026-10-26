-- #1335: the owner's whole coding history across every instance — what the picker chose, what it passed over and why, what was
-- queued, admitted, refused or deferred, and which of that became a real run.
--
-- Nothing here is a second ledger. The facts already live in `instance_objective_queue` (an ATTEMPT), `agent_loop_runs` (a RUN),
-- `loop_start_receipts` (a refused or duplicate request), `objective_lifecycle_events` (the transitions, #1017) and `auto_pickup_log`
-- (the picker's decisions, #1233). This adds only what a cross-instance, filterable, pageable read could not do without:
--
-- 1. `issue_number` on queue entries and runs, written when the row is created (read from the objective's own reference). A row
--    created before this carries NULL and reads back as "issue not recorded" — it is never reconstructed afterwards. An
--    auto-picked entry already names its issue in `metadata.autoPickup`, and the read falls back to that.
-- 2. The picker's `passed_over` outcome: an eligible candidate the start guard refused (recently done, already running, ...), with
--    the reason, so "why did it skip #N" is a row, not a sentence inside another row's detail. SQLite cannot widen a CHECK in
--    place, so `auto_pickup_log` is rebuilt (as 0273 did). The enqueue trigger (0280) writes into it, so it is dropped first and
--    recreated, byte for byte except that it now also stamps `issue_number` on the queue entry it creates.
-- 3. Owner-wide indexes, so a fleet read is an index range per source, not a scan.
ALTER TABLE instance_objective_queue ADD COLUMN issue_number INTEGER;
ALTER TABLE agent_loop_runs ADD COLUMN issue_number INTEGER;

DROP TRIGGER auto_pickup_admission_enqueue;

CREATE TABLE auto_pickup_log_new (
  id           TEXT PRIMARY KEY,
  instance_id  TEXT NOT NULL REFERENCES agent_instances(id),
  user_id      TEXT NOT NULL,
  repo         TEXT,
  issue_number INTEGER,
  outcome      TEXT NOT NULL CHECK (outcome IN ('started', 'none_eligible', 'skipped_failed', 'capped', 'skipped_gate', 'skipped_busy', 'error', 'passed_over')),
  detail       TEXT,
  created_at   INTEGER NOT NULL,
  reserved     INTEGER NOT NULL DEFAULT 0,
  entry_id     TEXT
);
INSERT INTO auto_pickup_log_new (id, instance_id, user_id, repo, issue_number, outcome, detail, created_at, reserved, entry_id)
  SELECT id, instance_id, user_id, repo, issue_number, outcome, detail, created_at, reserved, entry_id FROM auto_pickup_log;
DROP TABLE auto_pickup_log;
ALTER TABLE auto_pickup_log_new RENAME TO auto_pickup_log;
CREATE INDEX IF NOT EXISTS idx_auto_pickup_log_instance ON auto_pickup_log(instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auto_pickup_log_user ON auto_pickup_log(user_id, created_at DESC, id);

CREATE TRIGGER auto_pickup_admission_enqueue
AFTER INSERT ON auto_pickup_admissions
BEGIN
  INSERT INTO instance_objective_queue
    (id, instance_id, repo_id, user_id, objective, max_iterations, metadata, status, created_at, deferral_count, issue_number)
  VALUES
    (NEW.queue_entry_id, NEW.instance_id, NEW.repo_id, NEW.user_id, NEW.objective, NEW.max_iterations,
     json_object('autoPickup', json_object('repo', NEW.repo, 'issue', NEW.issue_number)), 'pending', NEW.created_at, 0, NEW.issue_number);
  INSERT INTO auto_pickup_log
    (id, instance_id, user_id, repo, issue_number, outcome, detail, created_at, entry_id)
  VALUES
    (NEW.queue_entry_id, NEW.instance_id, NEW.user_id, NEW.repo, NEW.issue_number, 'started', NEW.detail, NEW.created_at, NEW.queue_entry_id);
END;

CREATE INDEX IF NOT EXISTS idx_instance_objective_queue_user ON instance_objective_queue(user_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_agent_loop_runs_user_started ON agent_loop_runs(user_id, started_at DESC, run_id);
