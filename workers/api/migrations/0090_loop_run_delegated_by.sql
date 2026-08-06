-- Which supervisor asked for this run (#318).
--
-- `check_work` answers "did I really do that?" from `agent_loop_runs`, scoped to the CALLING
-- instance — deliberately, so an agent cannot read another of the owner's agents' runs and
-- describe them as its own. But a supervisor's work is never on its own instance: `delegate_goal`
-- starts the run on the SUBORDINATE. So a Lead that had just delegated (and said so, truthfully)
-- read back "you have not started any work on this instance — there are no runs. If you told the
-- user you did something, that was wrong; say so", and retracted a true statement. The #254
-- anti-hallucination guard manufacturing the exact failure it exists to prevent.
--
-- The supervisor was already known when the run started — `onBehalfOf` (#185) is threaded into
-- every driver — and was then thrown away. Recording it makes "runs I started somewhere else" one
-- indexed read.
--
-- Why not derive it from the supervision graph instead: "every run on an agent I supervise" is a
-- DIFFERENT set. It includes runs the owner started on that subordinate directly, and reporting
-- those as the supervisor's own would be a fresh over-claim in the opposite direction — the very
-- thing the instance scoping was added to stop.
--
-- AUDIT-shaped, never an authority: nothing consults this column to decide what may run
-- (lib/execution-authority.ts). NULL for every run somebody started on their own agent.
ALTER TABLE agent_loop_runs ADD COLUMN delegated_by TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_loop_runs_delegated_by
  ON agent_loop_runs(user_id, delegated_by, started_at DESC);
