-- #1229: a fill run paused for a sign-in on a host with a stored password login signs itself in from the vault.
--
-- One attempt per run: the row is claimed before the credential is read, so two syncs never type it twice, and
-- a wrong password is never retried in a loop. What is kept is the host, the id of the credential used and the
-- outcome — the audit trail. Never the username or the password: they pass through one request to the runner.
CREATE TABLE IF NOT EXISTS local_apply_vault_sign_ins (
  run_id         TEXT PRIMARY KEY REFERENCES local_apply_runs(id),
  instance_id    TEXT NOT NULL REFERENCES agent_instances(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  host           TEXT NOT NULL,
  credential_id  TEXT,
  state          TEXT NOT NULL CHECK (state IN ('signing_in', 'signed_in', 'failed')),
  failure        TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_local_apply_vault_sign_ins_instance ON local_apply_vault_sign_ins(instance_id, host);
