-- #1315: one statement commits the allowance, objective and receipt together. The conditional
-- admission INSERT serializes competing wakes; these trigger writes share its transaction.
-- A process dying after this commit leaves a normal pending objective, which the picker recovers.
CREATE TABLE auto_pickup_admissions (
  admission_id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_entry_id TEXT NOT NULL UNIQUE,
  instance_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  objective TEXT NOT NULL,
  max_iterations INTEGER NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_auto_pickup_admissions_instance ON auto_pickup_admissions(instance_id, admission_id DESC);
CREATE TRIGGER auto_pickup_admission_enqueue
AFTER INSERT ON auto_pickup_admissions
BEGIN
  INSERT INTO instance_objective_queue
    (id, instance_id, repo_id, user_id, objective, max_iterations, metadata, status, created_at, deferral_count)
  VALUES
    (NEW.queue_entry_id, NEW.instance_id, NEW.repo_id, NEW.user_id, NEW.objective, NEW.max_iterations,
     json_object('autoPickup', json_object('repo', NEW.repo, 'issue', NEW.issue_number)), 'pending', NEW.created_at, 0);
  INSERT INTO auto_pickup_log
    (id, instance_id, user_id, repo, issue_number, outcome, detail, created_at, entry_id)
  VALUES
    (NEW.queue_entry_id, NEW.instance_id, NEW.user_id, NEW.repo, NEW.issue_number, 'started', NEW.detail, NEW.created_at, NEW.queue_entry_id);
END;
