-- #1442: preserve every prior handoff and allow one new handoff per fresh runner pause.
CREATE TABLE local_apply_handoffs_new (
  id                    TEXT PRIMARY KEY,
  continuity_id         TEXT NOT NULL UNIQUE,
  run_id                TEXT NOT NULL REFERENCES local_apply_runs(id) ON DELETE CASCADE,
  application_id        TEXT NOT NULL,
  instance_id           TEXT NOT NULL REFERENCES agent_instances(id),
  user_id               TEXT NOT NULL REFERENCES users(id),
  -- This is the existing declared profile name (for exact-run matching), not browser state.
  browser_profile       TEXT NOT NULL,
  state                 TEXT NOT NULL CHECK (state IN ('requested', 'ready', 'closed')),
  terminal_reason       TEXT,
  expires_at            INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  activated_at          INTEGER,
  ended_at              INTEGER,
  updated_at            INTEGER NOT NULL,
  request_id            TEXT NOT NULL DEFAULT 'legacy',
  UNIQUE(run_id, request_id)
);
INSERT INTO local_apply_handoffs_new
  (id, continuity_id, run_id, application_id, instance_id, user_id, browser_profile, state, terminal_reason, expires_at, created_at, activated_at, ended_at, updated_at)
SELECT id, continuity_id, run_id, application_id, instance_id, user_id, browser_profile, state, terminal_reason, expires_at, created_at, activated_at, ended_at, updated_at
FROM local_apply_handoffs;
DROP TABLE local_apply_handoffs;
ALTER TABLE local_apply_handoffs_new RENAME TO local_apply_handoffs;
CREATE INDEX idx_local_apply_handoffs_owner
  ON local_apply_handoffs(user_id, instance_id, application_id, created_at DESC);
