-- Run lifecycle events, owner-scoped (#579).
--
-- A run's END was recorded (agent_loop_runs.status/finished_at) but never announced: the only way
-- to learn a run had finished was to poll its status, and the push that exists (`notifyUser`)
-- fires on completion for coding alone — apply and browser push only on a pause, the loop only
-- when it needs a human. This table is the one durable fact per terminal transition, written by
-- the run's terminal writers (`finishLoopRun`, the sweeper's `closeRuns`, `retireDisplacedRuns`):
--
--   • `seq` is the cursor an event feed pages on (`GET /v1/instances/:id/run-events?since=`), so a
--     client can await completion without re-reading run state;
--   • UNIQUE(run_id, event_type) is duplicate prevention: a second terminal write for the same run
--     (a retried finish, an overlapping sweep) records nothing new;
--   • `routed_at` is the hand-off to the connection outbox (0058). The per-minute cron routes every
--     unrouted row through `deliverEvent` and only then stamps it, so an event recorded just before
--     a crash is still routed on the next tick (at-least-once), and a tick that overlaps another is
--     collapsed by the outbox's idempotency key (no duplicate delivery);
--   • `run.finished` (the run closed itself) and `run.stalled` (the platform closed a run that had
--     stopped reporting) are distinct types because they come from distinct producers, and a stall
--     is actionable where a clean failure is not.
--
-- user_id and instance_id are copied from the run row, never supplied by a caller, so the feed is
-- owner-scoped by construction.
CREATE TABLE IF NOT EXISTS run_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  instance_id  TEXT NOT NULL,
  event_type   TEXT NOT NULL CHECK (event_type IN ('run.finished', 'run.stalled')),
  payload      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  routed_at    INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_run_type ON run_events(run_id, event_type);
CREATE INDEX IF NOT EXISTS idx_run_events_owner_feed ON run_events(user_id, instance_id, seq);
CREATE INDEX IF NOT EXISTS idx_run_events_unrouted ON run_events(routed_at, seq);
