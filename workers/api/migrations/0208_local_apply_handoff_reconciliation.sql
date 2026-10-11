-- #1013: a site-login handoff is an opaque, short-lived capability for one owner's
-- already-running local Application Runner.  This table deliberately contains no browser
-- storage, cookies, page URL/content, form values, credentials, or screenshot data.  The live
-- Runner remains the only place that holds a page.
CREATE TABLE IF NOT EXISTS local_apply_handoffs (
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
  UNIQUE(run_id)
);
CREATE INDEX IF NOT EXISTS idx_local_apply_handoffs_owner
  ON local_apply_handoffs(user_id, instance_id, application_id, created_at DESC);

-- An uncertain submit remains uncertain unless an explicit, structured, authorized-profile
-- reconciliation says otherwise.  We store the result category and stable material/job binding
-- only.  We intentionally do NOT retain raw site history, receipts, URLs, browser state, or any
-- credential-bearing evidence.
CREATE TABLE IF NOT EXISTS local_apply_reconciliations (
  id                         TEXT PRIMARY KEY,
  run_id                     TEXT NOT NULL REFERENCES local_apply_runs(id) ON DELETE CASCADE,
  application_id             TEXT NOT NULL,
  instance_id                TEXT NOT NULL REFERENCES agent_instances(id),
  user_id                    TEXT NOT NULL REFERENCES users(id),
  reconciliation_state       TEXT NOT NULL CHECK (reconciliation_state IN ('requested', 'no_submission_proven', 'submission_confirmed', 'ambiguous', 'unavailable', 'rejected')),
  -- Closed vocabulary, not an evidence blob.  NULL while still requested.
  proof_kind                 TEXT,
  job_identity               TEXT NOT NULL,
  material_lead_version      INTEGER,
  material_profile_version   TEXT,
  material_resume_sha        TEXT,
  material_cover_letter_sha  TEXT,
  requested_at               INTEGER NOT NULL,
  resolved_at                INTEGER,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL,
  UNIQUE(run_id)
);
CREATE INDEX IF NOT EXISTS idx_local_apply_reconciliations_owner
  ON local_apply_reconciliations(user_id, instance_id, application_id, created_at DESC);

-- Append-only operator-visible audit; the reason is a closed vocabulary supplied by code, never
-- a site response, text field, cookie, token, callback code, or screenshot.
CREATE TABLE IF NOT EXISTS local_apply_reconciliation_events (
  id                   TEXT PRIMARY KEY,
  reconciliation_id    TEXT NOT NULL REFERENCES local_apply_reconciliations(id) ON DELETE CASCADE,
  user_id              TEXT NOT NULL REFERENCES users(id),
  actor                TEXT NOT NULL CHECK (actor IN ('owner', 'runner', 'system')),
  event_type           TEXT NOT NULL CHECK (event_type IN ('requested', 'proof_recorded', 'state_transition', 'rejected')),
  reason_code          TEXT,
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_local_apply_reconciliation_events
  ON local_apply_reconciliation_events(reconciliation_id, created_at, id);
