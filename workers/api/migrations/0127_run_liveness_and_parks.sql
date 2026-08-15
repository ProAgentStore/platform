-- Liveness, progress and a park are three different facts about a run (#580).
--
-- 0067 added `last_progress_at` as "the only queryable staleness signal". It has since acquired a
-- second job that contradicts the first. `workflows/coding-session.ts`'s pause tick calls
-- `recordIteration(runId, pilotSteps)` on a timer while a run is parked, and `recordIteration`'s
-- one statement writes `iteration` AND `last_progress_at` together — so the column advances on a
-- run that is not advancing. Its stated purpose is exactly that: without it `sweepStaleRuns` closes
-- a legitimately parked run as dead at 3h.
--
-- Both requirements are real and they are not the same requirement:
--
--   * the ORCHESTRATOR is still ticking          — what the sweeper must not kill
--   * the RUN advanced an instruction            — what a stall detector must read
--   * the run is DELIBERATELY WAITING, until X   — what neither column could ever express
--
-- Measured: run 70ea298e reported `status:"running"`, `iteration:1/30` and a `lastProgressAt` 3.5
-- minutes old, 4.35 HOURS after it started, while `coding_session_capture.runState` said `idle` and
-- the pane read "You've hit your weekly limit · resets Aug 17 at 4pm". Nothing was wrong with the
-- run's own behaviour — it was parked on an engine usage limit, which `coding-wait.ts` permits for
-- up to six hours — and no field on the row could say so. The owner read a fresh timestamp as work.
--
-- 1. `last_alive_at` — the heartbeat. Written by every tick AND by every real advance (progress
--    implies liveness), so the sweeper reads THIS and a parked run still survives its 3h cutoff.
--    Nullable: pre-0127 rows and any run that dies before its first tick fall back through
--    COALESCE to `last_progress_at` and then `started_at`, which is the rule the sweeper and
--    `summarizeSubordinates` already share.
--
-- 2. `waiting_until` / `waiting_reason` — a park, named and dated. This is the field whose absence
--    made a truthful report impossible: "running" and "stalled" were the only two things the record
--    could say, and the run was neither. `waiting_reason` is a short platform enum
--    (`engine_limit`, `human`, `platform_interrupt`), never free text.
--
-- 3. `interruptions` — how many times a PLATFORM event (our own deploy resetting a Durable Object)
--    interrupted this run and it was resumed (#583). A durable counter, because the resume works by
--    letting the error escape `run()` so Cloudflare replays the journal — which re-executes every
--    line outside `step.do`, so an in-memory counter would reset on the very event it bounds.
--
-- No backfill. Every column is nullable-or-defaulted and every reader COALESCEs, so an in-flight
-- run at deploy time keeps behaving exactly as it did before this migration.

ALTER TABLE agent_loop_runs ADD COLUMN last_alive_at INTEGER;
ALTER TABLE agent_loop_runs ADD COLUMN waiting_until INTEGER;
ALTER TABLE agent_loop_runs ADD COLUMN waiting_reason TEXT;
ALTER TABLE agent_loop_runs ADD COLUMN interruptions INTEGER NOT NULL DEFAULT 0;
