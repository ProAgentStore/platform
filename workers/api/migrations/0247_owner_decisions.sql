-- #1079: an owner's decision is durable for every agent type, not only the coder (#1075).
--
-- One row per question a run paused on — or per answer the owner gave without a recorded pause —
-- keyed to its subject and the card it is answered on. The coder keeps `coder_questions` (its brain,
-- park and checkout machinery hang off it); this is the same contract for the others:
--   subject_kind = 'job_apply' → subject_id = the runner task, scope = the job URL
--   subject_kind = 'apply_run' → subject_id = the application, scope = the application id
-- An answer is ALWAYS written here first, whatever became of the run; `applied_at`/`applied_ref`
-- record which run consumed it (the resume, or the next run that matched `scope`). Answers are the
-- same data class as the Profile they are also saved to (form values), bounded at 2,000 characters.
CREATE TABLE IF NOT EXISTS owner_decisions (
  id            TEXT PRIMARY KEY,
  instance_id   TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('job_apply', 'apply_run')),
  subject_id    TEXT NOT NULL,
  task_id       TEXT,
  scope         TEXT,
  field         TEXT,
  question      TEXT NOT NULL,
  answer        TEXT,
  answered_via  TEXT CHECK (answered_via IN ('console', 'mcp')),
  asked_at      INTEGER NOT NULL,
  answered_at   INTEGER,
  applied_at    INTEGER,
  applied_ref   TEXT,
  history       TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_owner_decisions_card ON owner_decisions(instance_id, task_id, asked_at DESC);
CREATE INDEX IF NOT EXISTS idx_owner_decisions_scope ON owner_decisions(subject_kind, instance_id, scope, answered_at);
