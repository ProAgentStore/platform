-- #1015: one writer per repository checkout, across EVERY way an engine can be driven.
--
-- A run claims a session through `driver_id` (0069). A DIRECT turn — `POST …/coding/sessions/:sid/message`
-- — claimed nothing: it could reactivate a retained session whose run had ended while another run
-- worked the same checkout, and no later loop start or queue drain could see it. These two columns
-- are that claim. Set when a direct turn is admitted, cleared only when the runner confirms the
-- engine is idle or gone; an unknown engine keeps the claim (fail closed).
ALTER TABLE coding_sessions ADD COLUMN direct_turn_id TEXT;
ALTER TABLE coding_sessions ADD COLUMN direct_turn_at INTEGER;

-- What the owner told an engine, and what is KNOWN about its delivery (#1015). Steering a running
-- engine is three different facts that used to be reported as one "Sent": whether the engine was
-- idle (`delivered`), busy and will take it after the current turn (`queued`), or busy and had that
-- turn aborted (`interrupting`); and, separately and later, whether the engine has since completed
-- a turn that ended after the delivery (`processed_at`). The Pilot reloads a run's directives before
-- every decision, so an owner correction outlives the round it arrived in.
CREATE TABLE IF NOT EXISTS coding_session_directives (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES coding_sessions(id),
  instance_id TEXT NOT NULL REFERENCES agent_instances(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  repo_id TEXT,
  -- The run driving the session at delivery, when one was: a STEER of that run. Null: a direct turn.
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'steer')),
  delivery TEXT NOT NULL CHECK (delivery IN ('delivered', 'queued', 'interrupting')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_coding_session_directives_session ON coding_session_directives(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_coding_session_directives_run ON coding_session_directives(run_id, created_at);
