-- #1728: two independent defects in coding-queue admission. Nothing here edits or deletes an existing row.
--
-- 1. A checkout-REPAIR run is maintenance, not delivery. It ended `done` like any run, so the start guard counted it as the
--    issue being finished (`already_done`, #1253) and the per-issue counter recorded it as a success (#1336) — which settles the
--    FEATURE attempt it never made. `maintenance` marks the run at the moment it is created (like `preflight_blocked`, 0342: the
--    run stays on the record, it is only kept out of the tallies that mean "this issue was worked"). NULL = an ordinary run.
--    Rows written before this column stay NULL and age out of the 7-day window; they are not rewritten.
ALTER TABLE agent_loop_runs ADD COLUMN maintenance INTEGER;

-- 2. A forced start the owner already approved, queued behind a busy checkout, must still be that approved start at drain.
--    The route validated `force` + `force_reason` and then dropped both when it queued, so the drain re-ran the duplicate check
--    as an ordinary start and refused the issue it had been told to start. The approval is carried in these SERVER-WRITTEN columns
--    (never in `metadata`, which is caller-owned): the owner's own reason, the one issue and repository it was given for, when,
--    and when its audit comment was posted so it is posted once however many times the entry is drained.
ALTER TABLE instance_objective_queue ADD COLUMN approval_reason TEXT;
ALTER TABLE instance_objective_queue ADD COLUMN approval_issue INTEGER;
ALTER TABLE instance_objective_queue ADD COLUMN approval_repo_id TEXT;
ALTER TABLE instance_objective_queue ADD COLUMN approval_at INTEGER;
ALTER TABLE instance_objective_queue ADD COLUMN approval_audited_at INTEGER;
