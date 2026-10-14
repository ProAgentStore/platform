-- #1063: screenshot replay for every browser-driven run, as ONE owner-scoped artifact contract.
--
-- A replay screenshot is stored evidence, addressed by the run it belongs to (its SUBJECT) — the same
-- subject identifiers live takeover uses, kept separate from it:
--   runtime_task       a workflow-driven browser task (JOB_APPLY, BROWSER_TASK): instance_runtime_tasks.id
--   local_browser_run  a Scout's local research run:                            local_browser_runs.id
--   local_apply_run    an Application Runner fill run:                          local_apply_runs.id
--
-- The bytes live in R2 (`browser-artifacts/{user}/{instance}/{subjectKind}/{subjectId}/{seq}.jpg`) and are
-- served only through owner-checked routes. This row carries metadata only — the capture point, a
-- query-free URL, its domain and the action class — never page text, form values or typed values.
-- `expires_at` is fixed at write time from the subject's retention, so one indexed sweep deletes the
-- R2 object and the row together. Legacy `runshot/` objects are not tracked here and are left as they are.
CREATE TABLE IF NOT EXISTS browser_run_artifacts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  instance_id   TEXT NOT NULL,
  subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('runtime_task', 'local_browser_run', 'local_apply_run')),
  subject_id    TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'screenshot' CHECK (kind IN ('screenshot')),
  content_type  TEXT NOT NULL,
  r2_key        TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  point         TEXT NOT NULL,
  url           TEXT,
  domain        TEXT,
  action        TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_run_artifacts_subject ON browser_run_artifacts (subject_kind, subject_id, seq);
CREATE INDEX IF NOT EXISTS idx_browser_run_artifacts_owner ON browser_run_artifacts (user_id, instance_id, subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS idx_browser_run_artifacts_expiry ON browser_run_artifacts (expires_at);
