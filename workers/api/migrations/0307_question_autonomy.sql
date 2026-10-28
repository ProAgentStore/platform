-- #1385: an enforceable `questions: "ask" | "decide"` autonomy setting for coding runs.
--
-- Owners told runs "don't park on questions: decide, record on the issue, continue" in the objective, and the runs parked anyway: prose in an
-- objective is advisory. The setting is the platform's, not the objective's:
--   • per run   — `agent_loop_runs.questions_policy`, written when the run starts (the start's value, else the instance default, else 'ask');
--   • per instance — a `questions` field next to the iteration bounds in `agent_instances.config.loopLimits` (no column needed).
-- NULL is every run before this existed, and reads as 'ask': behaviour is unchanged unless an owner opts in.
ALTER TABLE agent_loop_runs ADD COLUMN questions_policy TEXT;

-- What a run's `decide` policy did with each question it would have parked on, so an owner can review it afterwards (and `coding_loop_status`
-- can show it). One row per question: 'decided' = the run took the most reversible option itself and carried on (the decision and the
-- alternatives are here and were posted on the linked issue); 'parked' = `decide` did NOT apply — it names the guardrail (a credential, a
-- destructive act, spend, money, or nothing safe to choose) — and the run parked as it always does. No objective text, no secrets: the question
-- and options are the ones the run itself published on the issue.
-- Not keyed to a foreign key: a run's history outlives the checks that would cascade it, and the cascade list only needs tables that can block a delete.
CREATE TABLE IF NOT EXISTS run_question_decisions (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  instance_id  TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  round        INTEGER NOT NULL DEFAULT 0,
  question     TEXT NOT NULL,
  options      TEXT NOT NULL DEFAULT '[]',
  outcome      TEXT NOT NULL CHECK (outcome IN ('decided', 'parked')),
  decision     TEXT,
  alternatives TEXT NOT NULL DEFAULT '[]',
  excluded     TEXT NOT NULL DEFAULT '[]',
  reason       TEXT NOT NULL,
  guardrail    TEXT,
  issue_repo   TEXT,
  issue_number INTEGER,
  posted       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_question_decisions_run ON run_question_decisions(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_question_decisions_user ON run_question_decisions(user_id, instance_id, created_at DESC);
