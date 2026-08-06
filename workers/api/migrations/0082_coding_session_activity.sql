-- When was this coding session last INTERACTED with? (#275)
--
-- #271 stopped a run from ending a session it did not open. That was right — ending someone else's
-- session is the surprising half — but ending-every-run was also, accidentally, the only thing that
-- reaped sessions, and nothing replaced it with a deliberate policy. The result is a session left
-- `active` forever, with a live `claude --dangerously-skip-permissions` child process resident on
-- the user's laptop. Not untidy: a permanent resident per repo.
--
-- Reaping needs a signal for "nobody is using this", and none of the existing columns is one:
--   • `updated_at` moves on claim/reassign/end/suspend, i.e. on lifecycle events, NOT on use. A
--     session driven hard for an hour can have an `updated_at` an hour old.
--   • `driver_at` is the Pilot's single-flight heartbeat. It says a WORKFLOW is alive; it says
--     nothing about a human sitting in the terminal, and it expires at STALE_DRIVER_MS (15 min),
--     which is the claim expiring, not the session.
--   • `started_at` is fixed at creation.
--
-- So: one column, written by every path that means somebody (or some Pilot) is engaged with this
-- session — capture polls, messages, runs, explains, restarts, timeline reads. Writes are throttled
-- to one a minute per session (`touchSessionActivity`), so the 3s capture poll costs zero rows
-- written on 19 polls out of 20 while still keeping a watched session permanently un-reapable.
--
-- Backfilled from `updated_at` rather than left NULL: a NULL would read as "never active" to any
-- cutoff comparison, and the first sweep after deploy would reap every existing session at once.
ALTER TABLE coding_sessions ADD COLUMN last_activity_at INTEGER;

UPDATE coding_sessions
   SET last_activity_at = CAST(strftime('%s', updated_at) AS INTEGER) * 1000
 WHERE last_activity_at IS NULL;

-- The sweeper's only query shape: active sessions ordered by how long they have been quiet.
CREATE INDEX IF NOT EXISTS idx_coding_sessions_activity ON coding_sessions(status, last_activity_at);
