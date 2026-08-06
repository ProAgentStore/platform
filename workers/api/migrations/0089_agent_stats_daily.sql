-- Daily stats rollup (#313).
--
-- NOT a perf optimisation, and not a fifth record of what happened.
--
-- For AGENT-DEFINED collections a daily snapshot is the only way to get a time series at all. The
-- lead-finder's `leads` collection holds records under a schema the AGENT defined; you can count
-- them now, but "leads found per day" needs either a timestamp we control on every record (we do
-- not have one — the shape is the agent's) or a snapshot taken each day. There is no third option,
-- and no amount of querying the collection later recovers a history nobody recorded.
--
-- Platform-owned sources (ai_usage 0048, agent_loop_runs 0062, pipeline_runs 0052,
-- agent_trigger_events 0045) DO carry timestamps and could be aggregated live; rolling those up is
-- then a genuine saving, but it is the secondary reason. Nothing here duplicates those tables —
-- this stores one scalar per (card, day), computed FROM them.
--
-- ## A missing day is a gap, not a zero
--
-- If the agent did not run, there is no row, and the series carries `null` for that day. `null`
-- renders as a BREAK in the line, never as 0. Reporting 0 says "you found no leads on Tuesday"
-- when the truth is "nothing ran on Tuesday" — a plausible value standing in for absent
-- information, the same class as #243 (an unparseable limit silently meaning "drop everything")
-- and #252 (idle rendered over live work). `stats-rollup.test.ts` asserts the two are
-- distinguishable end to end, because this is exactly the kind of thing a later change
-- "simplifies" to `?? 0`.
--
-- ## Completed days only
--
-- The sweep writes YESTERDAY's row, never today's. A completed UTC day is immutable, so
-- INSERT-once on the primary key is exactly right: overlapping cron minutes cannot double-write,
-- and no row is ever wrong-because-partial. A partial day charted next to complete ones reads as a
-- collapse in the metric, which is the same lie in a different shape.
--
-- ## No backfill
--
-- History starts the day this ships. The surface says so rather than presenting a three-day series
-- as though it were the whole picture.

CREATE TABLE IF NOT EXISTS agent_stats_daily (
  instance_id TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  card_id     TEXT NOT NULL,
  day         TEXT NOT NULL,              -- UTC date, YYYY-MM-DD
  value_json  TEXT NOT NULL,              -- JSON scalar; JSON so a future card kind can widen it
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (instance_id, card_id, day)
);

-- The read is always (instance, card, day-range), which the primary key's implicit index already
-- serves. This one is for the RETENTION sweep, which scans by day across every instance — without
-- it the ~400-day cap becomes a full-table scan every time it runs.
CREATE INDEX IF NOT EXISTS idx_agent_stats_daily_day ON agent_stats_daily(day);
