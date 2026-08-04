-- Durable agent-loop runs (#158).
--
-- The platform already owned the THINKING: `/v1/instances/:id/loop-decide` lives in
-- routes/instances.ts (not coding.ts) and is agent-generic. The browser owned the PERSISTENCE:
-- the console polled that endpoint and sent the next instruction, so closing the tab, locking a
-- phone or sleeping a laptop killed an in-flight objective.
--
-- Two consequences, one product and one structural:
--   • an objective could not survive the tab closing, which is a plain UX defect;
--   • spend could not be bounded, because you cannot budget a loop you do not drive. Every
--     enforcement point #184 needs sits on the server side of a loop the server did not run.
--
-- This table is the run record for a server-driven loop, so the console can become a thin UI
-- over it (start / watch / interject / stop) instead of a parallel client-driven brain. Shape
-- deliberately mirrors `pipeline_runs` (0052) — same vocabulary, so the two run histories can
-- render from one model rather than two.

CREATE TABLE IF NOT EXISTS agent_loop_runs (
  run_id        TEXT PRIMARY KEY,              -- also the trace id grouping this run's events
  user_id       TEXT NOT NULL,
  instance_id   TEXT NOT NULL,
  objective     TEXT NOT NULL,

  status        TEXT NOT NULL DEFAULT 'running',  -- running | completed | failed | needs_human | cancelled
  -- Distinct from `status` on purpose: "why did it end" is not "what state is it in". A run that
  -- stopped on max_iterations and one that stopped because it kept repeating are both 'failed',
  -- and telling them apart is the difference between "raise the cap" and "the objective is wrong".
  stop_reason   TEXT,                            -- done|escalated|failed|max_iterations|budget|cancelled|no_progress
  detail        TEXT,                            -- human-facing terminal message

  iteration      INTEGER NOT NULL DEFAULT 0,
  max_iterations INTEGER NOT NULL,
  -- Set when a human asks it to stop. Checked at the top of each iteration, so cancelling is
  -- cooperative rather than a kill: the in-flight step finishes and its spend is settled.
  cancel_requested INTEGER NOT NULL DEFAULT 0,

  -- The delegation budget this run draws against (#184), when it has one.
  budget_id     TEXT,

  started_at    INTEGER NOT NULL,                -- ms epoch
  finished_at   INTEGER,                         -- ms epoch, null while running
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_loop_runs_instance
  ON agent_loop_runs(instance_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_loop_runs_user
  ON agent_loop_runs(user_id, started_at DESC);
