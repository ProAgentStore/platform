-- #1671: a run stopped at its pre-flight (the dirty/behind sync gate, #801) never executed the objective. It stays on the
-- record — nothing is deleted — but is marked, so the per-issue failed-run tallies and the "coding runs failed" comments do not
-- count an admission-class stop as a failed implementation attempt.
ALTER TABLE agent_loop_runs ADD COLUMN preflight_blocked INTEGER;
