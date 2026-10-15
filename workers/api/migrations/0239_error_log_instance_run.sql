-- Which INSTANCE and which RUN an error row belongs to (#1085).
--
-- `collapseRepeat` folded byte-identical failures inside one hour into one row keyed on source,
-- message, level, status, user and build. Instance and run were not in that key, so the same
-- failure on instances A, B and C became ONE row whose two retained context samples named A and C:
-- B was unqueryable, and the row's `repeat_count` could not say how many occurrences were whose.
--
-- ── Why columns, and why they join the collapse identity
--
-- Like `build` (0125) and unlike the free-form context, an instance id and a run id are not
-- per-occurrence measurements: they name a bounded set of real entities. Keying on them still
-- folds a repeat inside ONE instance's ONE run (the #423 flood was one sweep failing every minute,
-- which still collapses), while a failure spanning instances leaves one row per instance, each with
-- its own accurate count. A column is also what makes "this instance's errors" an indexed lookup
-- instead of `json_extract` over two samples.
--
-- `instance_id` is VERIFIED, never copied from caller input: `logError` reads the instance's owner
-- from `agent_instances` and keeps the instance only when it belongs to the row's user (or, for a
-- server path that named no user, takes that owner). A client report cannot attribute a row to an
-- instance its session does not own. `run_id` is the run/trace correlation id the trace bridge
-- already reads (`runId`, `traceId`, `taskId`, …); client reports never set it.
--
-- ── Legacy rows
--
-- Rows written before this migration keep NULL in both columns and are NOT backfilled. A legacy
-- collapsed row may stand for several instances, and its samples name at most two of them, so any
-- single value written here would claim more than is known. Readers fall back to the samples for
-- those rows and report the result as a lower bound, as they did before.
ALTER TABLE error_log ADD COLUMN instance_id TEXT;
ALTER TABLE error_log ADD COLUMN run_id TEXT;
CREATE INDEX IF NOT EXISTS idx_error_log_user_instance ON error_log(user_id, instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_user_run ON error_log(user_id, run_id, created_at DESC);
