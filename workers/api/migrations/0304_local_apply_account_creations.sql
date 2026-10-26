-- #1230: a fill run paused for a sign-in on a site where the owner has no account creates one, and stores it in the vault.
--
-- A provisional credential is a password the Runner generated and stored BEFORE it submitted the site's sign-up form, so a crash mid-signup
-- never leaves an account nobody can sign in to. Until the site has accepted the registration it is only a candidate: sign-in must not try it
-- (a password for an account that does not exist is how an account gets locked), and the owner sees it, marked, in Knowledge → Credentials.
-- `provisional = 0` is every credential that existed before this and every one the owner saves.
ALTER TABLE agent_credentials ADD COLUMN provisional INTEGER NOT NULL DEFAULT 0;

-- One attempt per run, and the audit trail: the host, which credential, the outcome. Never a profile value, the password or the code.
CREATE TABLE IF NOT EXISTS local_apply_account_creations (
  run_id         TEXT PRIMARY KEY REFERENCES local_apply_runs(id),
  instance_id    TEXT NOT NULL REFERENCES agent_instances(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  host           TEXT NOT NULL,
  credential_id  TEXT,
  mailbox        TEXT,
  state          TEXT NOT NULL CHECK (state IN ('preparing', 'prepared', 'submitting', 'code_requested', 'entering', 'created', 'failed')),
  requested_at   INTEGER,
  failure        TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_local_apply_account_creations_instance ON local_apply_account_creations(instance_id, host);
