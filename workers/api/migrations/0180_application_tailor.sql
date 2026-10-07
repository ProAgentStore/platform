-- Application Tailor (#956, epic #943): tailored résumé + cover letter for an approved job lead,
-- generated on the owner's machine by a subscription-signed-in Codex / Claude Code CLI.
--
-- `job_applications` is the application record — one per approved lead version, keyed by the
-- deterministic `idempotency_key` (the #955 event id), so a replayed `job.lead.apply_requested`
-- delivery returns the same record instead of starting a second run. It holds HANDLES only:
-- artifact paths + hashes, never résumé or profile content.
--
-- `local_artifact_runs` is the durable run, deliberately separate from `local_browser_runs` (no
-- browser, no domain consent) and from `coding_sessions` (no repository).
--
-- Instance settings are NOT a table: they live at `agent_instances.config.applicationTailor`.

CREATE TABLE IF NOT EXISTS job_applications (
  id                    TEXT PRIMARY KEY,
  instance_id           TEXT NOT NULL REFERENCES agent_instances(id),
  user_id               TEXT NOT NULL REFERENCES users(id),
  -- The instance whose triage emitted the lead (Job Search Scout).
  source_instance_id    TEXT NOT NULL,
  lead_id               TEXT NOT NULL,
  lifecycle_version     INTEGER NOT NULL,
  idempotency_key       TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'tailoring'
                        CHECK (status IN ('tailoring', 'materials_ready', 'blocked', 'failed', 'cancelled')),
  -- The approved lead envelope, exactly as received (whitelisted by #955 — no contact data).
  lead                  TEXT NOT NULL,
  tailoring_run_id      TEXT,
  resume_artifact       TEXT,
  cover_letter_artifact TEXT,
  profile_version       TEXT,
  generated_at          TEXT,
  -- Why it is waiting on the owner: missing_source | malformed_lead | workspace_unavailable |
  -- missing_information | uncertain_claim | engine_not_signed_in | api_key_refused | runner_lost | …
  block_reason          TEXT,
  -- What the owner must supply or confirm (questions only).
  block_questions       TEXT,
  -- The `job.application.materials_ready` envelope, written in the SAME update as the transition,
  -- and `ready_emitted_at` once it is in the connection outbox — so the emit survives a crash
  -- between the two and is retried, and the outbox key collapses any repeat.
  ready_event           TEXT,
  ready_emitted_at      INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_applications_key ON job_applications(instance_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_job_applications_instance ON job_applications(instance_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_applications_unemitted ON job_applications(status, ready_emitted_at);

CREATE TABLE IF NOT EXISTS local_artifact_runs (
  id              TEXT PRIMARY KEY,
  instance_id     TEXT NOT NULL REFERENCES agent_instances(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  application_id  TEXT NOT NULL REFERENCES job_applications(id),
  request_id      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'completed', 'needs_human', 'failed', 'cancelled')),
  -- engine, auth mode, workspace, source paths, retention, limits. No secret, no source content.
  policy          TEXT NOT NULL,
  result          TEXT,
  engine_auth     TEXT,
  error_code      TEXT,
  error           TEXT,
  runner_node     TEXT,
  -- Redacted, whitelisted trace events (contract.ts `parseLocalArtifactEvent`), capped.
  trace           TEXT NOT NULL DEFAULT '[]',
  runner_seq      INTEGER NOT NULL DEFAULT 0,
  last_synced_at  INTEGER,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  ended_at        INTEGER,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_local_artifact_runs_request ON local_artifact_runs(instance_id, request_id);
CREATE INDEX IF NOT EXISTS idx_local_artifact_runs_active ON local_artifact_runs(status, last_synced_at);
