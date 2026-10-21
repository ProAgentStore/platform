-- #1276: auto-pickup logs every skip, not only the four outcomes #1233 shipped with.
--   skipped_gate   → the wake was refused at the gate: the Pro gate, the account's daily budget or token
--                    ceiling (when enforcement is on), a question waiting on the owner, an inactive instance.
--   skipped_busy   → the coder still had queued or running work.
--   error          → the wake threw; `detail` is the message.
-- A repeat of the same outcome and detail is written at most once an hour (see auto-pickup.ts), so a
-- coder that stays blocked leaves one row to read, not one per sweep.
-- SQLite cannot widen a CHECK in place: the table is rebuilt and its rows copied across.
CREATE TABLE auto_pickup_log_new (
  id           TEXT PRIMARY KEY,
  instance_id  TEXT NOT NULL REFERENCES agent_instances(id),
  user_id      TEXT NOT NULL,
  repo         TEXT,
  issue_number INTEGER,
  outcome      TEXT NOT NULL CHECK (outcome IN ('started', 'none_eligible', 'skipped_failed', 'capped', 'skipped_gate', 'skipped_busy', 'error')),
  detail       TEXT,
  created_at   INTEGER NOT NULL
);
INSERT INTO auto_pickup_log_new (id, instance_id, user_id, repo, issue_number, outcome, detail, created_at)
  SELECT id, instance_id, user_id, repo, issue_number, outcome, detail, created_at FROM auto_pickup_log;
DROP TABLE auto_pickup_log;
ALTER TABLE auto_pickup_log_new RENAME TO auto_pickup_log;
CREATE INDEX IF NOT EXISTS idx_auto_pickup_log_instance ON auto_pickup_log(instance_id, created_at DESC);
