-- #1106: a fill run paused for a SEEK sign-in signs itself in with the code SEEK emails.
--
-- SEEK signs a jobseeker in with a one-time code sent to the account address. When the owner has
-- named that address (`applicationRunner.signInEmail`) and it is the Gmail mailbox this Runner is
-- pinned to (#715/#1095), PAGS asks the runner to request a code, reads it from that mailbox, and has
-- the runner enter it — no takeover. One attempt per run; anything that does not work ends `failed`
-- with a reason and the owner gets the ordinary sign-in handoff.
--
-- What is kept: the state, the mailbox the code was read from and the Gmail message id (the audit
-- trail the issue asks for). Never the code: it passes through one request to the runner and is gone.
CREATE TABLE IF NOT EXISTS local_apply_email_sign_ins (
  run_id        TEXT PRIMARY KEY REFERENCES local_apply_runs(id),
  instance_id   TEXT NOT NULL REFERENCES agent_instances(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  site          TEXT NOT NULL,
  mailbox       TEXT,
  state         TEXT NOT NULL CHECK (state IN ('requesting', 'code_requested', 'entering', 'signed_in', 'failed')),
  requested_at  INTEGER,
  message_id    TEXT,
  failure       TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_local_apply_email_sign_ins_instance ON local_apply_email_sign_ins(instance_id);
