-- #1407: an already_done-refused issue that is still open is no longer only logged `passed_over`
-- forever — it is closed (citing the finishing run, when CI is green on what it delivered) or
-- flagged `needs-human` for a person, and that decision needs its own outcome to be a row an owner
-- can filter on, not a sentence buried inside `passed_over`'s detail. SQLite cannot widen a CHECK in
-- place, so `auto_pickup_log` is rebuilt (as 0305 did for the same reason).
DROP TRIGGER auto_pickup_admission_enqueue;

CREATE TABLE auto_pickup_log_new (
  id           TEXT PRIMARY KEY,
  instance_id  TEXT NOT NULL REFERENCES agent_instances(id),
  user_id      TEXT NOT NULL,
  repo         TEXT,
  issue_number INTEGER,
  outcome      TEXT NOT NULL CHECK (outcome IN ('started', 'none_eligible', 'skipped_failed', 'capped', 'skipped_gate', 'skipped_busy', 'error', 'passed_over', 'closed_done', 'flagged_review')),
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
