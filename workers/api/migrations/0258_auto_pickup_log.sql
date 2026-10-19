-- #1233: what brain-free auto-pickup decided, each time a coder's queue emptied.
--   outcome  started        → it queued and started issue `issue_number` on `repo`
--            none_eligible  → no open issue qualified. The owner is told once, not on every empty queue:
--                             only when the previous row for the instance was something else.
--            skipped_failed → two auto-picked runs on this issue ended failed, so it is passed over;
--                             one comment is posted on the issue the first time.
--            capped         → the instance's daily auto-pickup cap was reached
--   detail   one line of why, for status views. No issue bodies are stored.
-- The daily cap counts `started` rows in the last 24 hours.
CREATE TABLE IF NOT EXISTS auto_pickup_log (
  id           TEXT PRIMARY KEY,
  instance_id  TEXT NOT NULL REFERENCES agent_instances(id),
  user_id      TEXT NOT NULL,
  repo         TEXT,
  issue_number INTEGER,
  outcome      TEXT NOT NULL CHECK (outcome IN ('started', 'none_eligible', 'skipped_failed', 'capped')),
  detail       TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auto_pickup_log_instance ON auto_pickup_log(instance_id, created_at DESC);
