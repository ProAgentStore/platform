-- #1412: a fill run paused for a sign-in is signed in by the agent itself, through its own browser tools, with
-- the login handed to the runner as NAMED secret placeholders the browser substitutes.
--
-- One attempt per run: the row is claimed before anything is handed over, so two syncs never provision twice.
-- What is kept is the host, the id of the vault credential used (if any), when the emailed code was asked for and
-- which Gmail message carried it, and the outcome — the audit trail. Never a username, a password or a code:
-- they pass through one request to the runner and live only in that run's browser until the sign-in ends.
CREATE TABLE IF NOT EXISTS local_apply_agent_sign_ins (
  run_id             TEXT PRIMARY KEY REFERENCES local_apply_runs(id),
  instance_id        TEXT NOT NULL REFERENCES agent_instances(id),
  user_id            TEXT NOT NULL REFERENCES users(id),
  host               TEXT NOT NULL,
  credential_id      TEXT,
  state              TEXT NOT NULL CHECK (state IN ('signing_in', 'signed_in', 'failed')),
  code_requested_at  INTEGER,
  code_message_id    TEXT,
  failure            TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_local_apply_agent_sign_ins_instance ON local_apply_agent_sign_ins(instance_id, host);
