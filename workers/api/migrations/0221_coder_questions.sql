-- #1025: one row per question a coding run parks on (`ask_owner` / `request_user_info`).
--
-- The question is DURABLE here so the timers can live in the every-minute sweep
-- (`runDueCoderQuestions`) instead of in a Workflow's memory: a question survives a worker
-- restart, and every state change is recorded on the row (`history`), in `coding_timeline` and
-- in `agent_events`. States:
--   waiting_human  → asked; the human was notified and the question posted on the issue
--   brain_deciding → the human timeout passed with the brain on; one decision is in flight
--   answered_human → a person answered (wins at any point)
--   answered_brain → the brain decided, inside its guardrails, and the answer was delivered
--   escalated      → the brain declined; the human was asked again
--   unresolved     → the escalation timeout passed; the coder was told to finish what it can
--   expired        → the run stopped waiting (brain off, or the run ended) with no answer
-- Times are ms since epoch. No secrets, no pane content beyond the question and its reason.
CREATE TABLE IF NOT EXISTS coder_questions (
  id            TEXT PRIMARY KEY,
  instance_id   TEXT NOT NULL REFERENCES agent_instances(id),
  user_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  run_id        TEXT,
  task_id       TEXT,
  repo          TEXT,
  issue_number  INTEGER,
  question      TEXT NOT NULL,
  options       TEXT,
  why           TEXT,
  state         TEXT NOT NULL CHECK (state IN ('waiting_human', 'brain_deciding', 'answered_human', 'answered_brain', 'escalated', 'unresolved', 'expired')),
  asked_at      INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  escalated_at  INTEGER,
  resolved_at   INTEGER,
  answered_by   TEXT CHECK (answered_by IN ('human', 'brain')),
  decision      TEXT,
  confidence    REAL,
  reason        TEXT,
  model         TEXT,
  prompt_hash   TEXT,
  history       TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_coder_questions_open ON coder_questions(state, asked_at);
CREATE INDEX IF NOT EXISTS idx_coder_questions_instance ON coder_questions(instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coder_questions_session ON coder_questions(session_id, state);
