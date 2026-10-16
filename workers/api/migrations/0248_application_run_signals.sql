-- #1107: what the owner has already been told about an application run, so a sweep that runs
-- every minute tells them once — not once per tick.
--
--   progress_stage    the furthest stage a `run_progress` update was raised for. Stages only move
--                     forward, so a run that goes fill → upload → fill does not ping-pong.
--   blocker_alerted   the last blocker a push was raised for (reason, and for a pause its time), so
--                     the same blocker is announced once and a NEW one still is.
--   stall_alerted_at  when the one `run_stalled` alert for this run was raised (ms epoch).
--
-- Each is claimed with a compare-and-set UPDATE before the push, so two overlapping syncs of the
-- same run cannot both announce it. Additive and nullable: a row written before this reads as
-- "nothing announced yet". That cannot re-announce history: progress and stalls are only raised for
-- a run still going, and a terminal blocker only for a run that ended in the last 30 minutes.

ALTER TABLE local_apply_runs ADD COLUMN progress_stage TEXT;
ALTER TABLE local_apply_runs ADD COLUMN blocker_alerted TEXT;
ALTER TABLE local_apply_runs ADD COLUMN stall_alerted_at INTEGER;

ALTER TABLE local_artifact_runs ADD COLUMN progress_stage TEXT;
ALTER TABLE local_artifact_runs ADD COLUMN blocker_alerted TEXT;
ALTER TABLE local_artifact_runs ADD COLUMN stall_alerted_at INTEGER;
