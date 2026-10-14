-- #1073: the owner's assertion that an uncertain submit sent nothing.
--
-- An application whose final submit was pressed and never confirmed (`submit_attempted_at` set) is
-- never filled again: a redirect is not proof (#994, #1013), and reconciliation cannot prove SEEK
-- history. The owner decided (run 08c5c27f, answering the #1013 question) that THEIR explicit,
-- audited assertion may stand in for proof and allow one clean retry.
--
-- This is an OWNER ASSERTION, never system proof: it lives in its own table, the reconciliation
-- record is left as it was (e.g. `ambiguous`), and every later run is traceable to it through
-- `consumed_run_id`. One per uncertain attempt (application + the fill run that attempted), spent
-- by exactly one new fill — which is also when the application's attempt marker is cleared;
-- `prior_submit_attempted_at` keeps what it said.
CREATE TABLE IF NOT EXISTS application_owner_assertions (
  id                         TEXT PRIMARY KEY,
  application_id             TEXT NOT NULL REFERENCES job_applications(id),
  -- The application's own (Tailor) instance, so the instance cascade removes it with its application.
  instance_id                TEXT NOT NULL REFERENCES agent_instances(id),
  user_id                    TEXT NOT NULL REFERENCES users(id),
  fill_run_id                TEXT NOT NULL,
  kind                       TEXT NOT NULL CHECK (kind IN ('not_submitted')),
  -- The owner's own words, as they declared them.
  statement                  TEXT NOT NULL,
  actor                      TEXT NOT NULL CHECK (actor IN ('owner_mcp', 'owner_console')),
  prior_submit_attempted_at  INTEGER NOT NULL,
  created_at                 INTEGER NOT NULL,
  consumed_at                INTEGER,
  consumed_run_id            TEXT,
  UNIQUE (application_id, fill_run_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_application_owner_assertions_owner
  ON application_owner_assertions(user_id, application_id, created_at DESC);
