-- Application Runner (#957, epic #943): a local, subscription-signed-in Codex / Claude Code CLI
-- fills an application whose materials are ready (#956), under an explicit write policy.
--
-- 1. `job_applications` gains the execution lifecycle. SQLite cannot widen a CHECK in place, so the
--    table is rebuilt (`local_artifact_runs` references it; D1 defers the FK check to commit):
--      materials_ready → filling | deferred | archived
--      filling         → awaiting_review | submitted | blocked | failed
--      blocked         → filling | failed | deferred | archived
--      awaiting_review → deferred | archived
--      deferred        → materials_ready | archived
--      failed          → archived
--    `state_version` is the compare-and-set token; `submitted_at` / `submitted_url` are written only
--    with a CONFIRMED submit; `submit_attempted_at` is set the moment a final submit may have
--    happened (including "unknown"), and from then on nothing starts another fill automatically.
-- 2. `job_application_events` — the durable audit row for every lifecycle transition, one per
--    (application, version), so a racing duplicate collapses instead of double-logging. Keyed to
--    the application's own instance, so it cascades with the application.
-- 3. `local_apply_runs` — the durable run, separate from `local_browser_runs` (research) and from
--    `local_artifact_runs` (tailoring). Its policy column records the mode and the submit-gate verdict.

PRAGMA defer_foreign_keys = true;

CREATE TABLE job_applications_new (
  id                    TEXT PRIMARY KEY,
  instance_id           TEXT NOT NULL REFERENCES agent_instances(id),
  user_id               TEXT NOT NULL REFERENCES users(id),
  source_instance_id    TEXT NOT NULL,
  lead_id               TEXT NOT NULL,
  lifecycle_version     INTEGER NOT NULL,
  idempotency_key       TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'tailoring'
                        CHECK (status IN ('tailoring', 'materials_ready', 'blocked', 'failed', 'cancelled',
                                          'filling', 'awaiting_review', 'submitted', 'deferred', 'archived')),
  lead                  TEXT NOT NULL,
  tailoring_run_id      TEXT,
  resume_artifact       TEXT,
  cover_letter_artifact TEXT,
  profile_version       TEXT,
  generated_at          TEXT,
  block_reason          TEXT,
  block_questions       TEXT,
  ready_event           TEXT,
  ready_emitted_at      INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  state_version         INTEGER NOT NULL DEFAULT 0,
  fill_run_id           TEXT,
  submit_attempted_at   INTEGER,
  submitted_at          TEXT,
  submitted_url         TEXT
);
INSERT INTO job_applications_new (id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, status, lead,
  tailoring_run_id, resume_artifact, cover_letter_artifact, profile_version, generated_at, block_reason, block_questions, ready_event,
  ready_emitted_at, created_at, updated_at)
SELECT id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, status, lead,
  tailoring_run_id, resume_artifact, cover_letter_artifact, profile_version, generated_at, block_reason, block_questions, ready_event,
  ready_emitted_at, created_at, updated_at
FROM job_applications;
DROP TABLE job_applications;
ALTER TABLE job_applications_new RENAME TO job_applications;
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_applications_key ON job_applications(instance_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_job_applications_instance ON job_applications(instance_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_applications_unemitted ON job_applications(status, ready_emitted_at);

CREATE TABLE IF NOT EXISTS job_application_events (
  id              TEXT PRIMARY KEY,
  application_id  TEXT NOT NULL REFERENCES job_applications(id),
  -- The application's own instance (the Tailor that holds it) — what an instance delete cascades on.
  instance_id     TEXT NOT NULL REFERENCES agent_instances(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  -- The state_version this transition produced: one audit row per version.
  version         INTEGER NOT NULL,
  from_status     TEXT NOT NULL,
  to_status       TEXT NOT NULL,
  -- runner | owner | system — who caused it.
  actor           TEXT NOT NULL,
  -- The instance that acted (the Application Runner), and its run.
  actor_instance_id TEXT,
  run_id          TEXT,
  reason          TEXT,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_application_events_version ON job_application_events(application_id, version);

CREATE TABLE IF NOT EXISTS local_apply_runs (
  id              TEXT PRIMARY KEY,
  instance_id     TEXT NOT NULL REFERENCES agent_instances(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  -- The application lives on ANOTHER of the owner's instances (the Tailor), so this is not a
  -- foreign key: deleting either agent must not be blocked by the other's rows. Reads are scoped
  -- by user_id, and the run row stays as the record of what the Runner did.
  application_id  TEXT NOT NULL,
  request_id      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'paused', 'awaiting_review', 'submitted', 'blocked', 'failed', 'cancelled')),
  -- engine, auth mode, profile, mode, allowed sites, limits, and the submit-gate verdict. No secret.
  policy          TEXT NOT NULL,
  pause           TEXT,
  result          TEXT,
  engine_auth     TEXT,
  error_code      TEXT,
  error           TEXT,
  runner_node     TEXT,
  -- Redacted, whitelisted trace events (contract.ts `parseLocalApplyEvent`), capped.
  trace           TEXT NOT NULL DEFAULT '[]',
  runner_seq      INTEGER NOT NULL DEFAULT 0,
  last_synced_at  INTEGER,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  ended_at        INTEGER,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_local_apply_runs_request ON local_apply_runs(instance_id, request_id);
CREATE INDEX IF NOT EXISTS idx_local_apply_runs_active ON local_apply_runs(status, last_synced_at);
CREATE INDEX IF NOT EXISTS idx_local_apply_runs_submits ON local_apply_runs(instance_id, user_id, created_at);
