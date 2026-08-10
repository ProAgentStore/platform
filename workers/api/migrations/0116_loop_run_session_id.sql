-- Link a coding loop run to its coding session (#465, follow-up to #459 criterion 1).
--
-- `agent_loop_runs` had no `session_id`. The coding Pilot has `session.id` at start and
-- puts it in the CODING_SESSION workflow params (`loop-drivers.ts:loopRunId`), but did
-- not store it on the run row. So `describeLoopRun` had no way to reach the live
-- `runState` from `/coding/capture`, and the run report could only state liveness
-- negatively ("NOT stalled") — never "the engine is working".
--
-- Nullable because the chat and pipeline drivers have no session. The column is OMITTED
-- (not empty) for a non-coding run, which keeps the engine clause absent rather than
-- rendered as "unknown".
--
-- Written once, on `createLoopRun`, and never updated — the session does not change
-- mid-run. No index needed: the `check_work` lookup is already by `run_id`.

ALTER TABLE agent_loop_runs ADD COLUMN session_id TEXT; -- NULL for non-coding runs
