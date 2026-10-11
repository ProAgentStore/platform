-- #1013 completion: an ended uncertain attempt may have one separately-authorized read-only
-- reconciliation browser session. This records opaque lifecycle only; never site/browser data.
CREATE TABLE IF NOT EXISTS local_apply_reconciliation_handoffs (
  id                TEXT PRIMARY KEY,
  continuity_id     TEXT NOT NULL UNIQUE,
  reconciliation_id TEXT NOT NULL UNIQUE REFERENCES local_apply_reconciliations(id) ON DELETE CASCADE,
  run_id            TEXT NOT NULL REFERENCES local_apply_runs(id) ON DELETE CASCADE,
  application_id    TEXT NOT NULL,
  instance_id       TEXT NOT NULL REFERENCES agent_instances(id),
  user_id           TEXT NOT NULL REFERENCES users(id),
  browser_profile   TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('requested', 'ready', 'closed')),
  terminal_reason   TEXT,
  expires_at        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  activated_at      INTEGER,
  ended_at          INTEGER,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_local_apply_reconciliation_handoffs_owner
  ON local_apply_reconciliation_handoffs(user_id, instance_id, run_id, application_id, created_at DESC);
