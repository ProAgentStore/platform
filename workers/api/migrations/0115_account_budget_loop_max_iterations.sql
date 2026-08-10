-- Per-account loop max-iterations ceiling (issue #477, epic #478).
--
-- The Loop orchestrator enforces a hard cap of 50 iterations (MAX_ITERATIONS_CAP in
-- agent-loop.ts). Any caller can pass a lower `maxIterations` at start time, but the
-- cap itself was not overridable without a deploy.
--
-- This column slots into account_budget_limits with the same four-tier resolution
-- (per-account → platform-default → env → hard constant = 50). An operator can raise
-- the maximum for power users; a user can lower their own default cap without touching
-- the code.
--
-- NULL = inherit from the next tier down (same semantic as every other column here).

ALTER TABLE account_budget_limits ADD COLUMN loop_max_iterations INTEGER; -- NULL = inherit
