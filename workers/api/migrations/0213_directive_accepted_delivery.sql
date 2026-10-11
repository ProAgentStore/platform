-- #1019: a directive whose engine state could not be read is ACCEPTED, not delivered.
--
-- 0211 recorded every directive as `delivered`, `queued` or `interrupting`, chosen from the engine's
-- state just before the send. When the runner could not say what the engine was doing (`unknown`),
-- `deliveryFor` answered `delivered` — a claim that the engine was idle and took the message, made on
-- no evidence. `accepted` is the honest fourth state: the runner took the message, and nothing is
-- known about how the engine met it. Processing stays the separate, later fact in `processed_at`.
--
-- SQLite cannot widen a CHECK in place, so the table is rebuilt (the 0170 pattern). Nothing references
-- this table, and every existing row is copied unchanged.

CREATE TABLE coding_session_directives_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES coding_sessions(id),
  instance_id TEXT NOT NULL REFERENCES agent_instances(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  repo_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'steer')),
  delivery TEXT NOT NULL CHECK (delivery IN ('accepted', 'delivered', 'queued', 'interrupting')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);

INSERT INTO coding_session_directives_new (id, session_id, instance_id, user_id, repo_id, run_id, kind, delivery, content, created_at, processed_at)
  SELECT id, session_id, instance_id, user_id, repo_id, run_id, kind, delivery, content, created_at, processed_at FROM coding_session_directives;

DROP TABLE coding_session_directives;
ALTER TABLE coding_session_directives_new RENAME TO coding_session_directives;

CREATE INDEX IF NOT EXISTS idx_coding_session_directives_session ON coding_session_directives(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_coding_session_directives_run ON coding_session_directives(run_id, created_at);
