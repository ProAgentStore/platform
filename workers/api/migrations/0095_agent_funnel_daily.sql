-- The public store funnel (#383) — how many people LOOKED at an agent, and how many
-- started a trial.
--
-- ## Why not `usage`
--
-- Both counters were read off `usage` and both were structurally zero. `trial_start` was
-- never written by anything. `view` WAS written, by `GET /v1/public/agents/:id`, binding
-- `user_id = ''` into a column declared `user_id TEXT NOT NULL REFERENCES users(id)`
-- (0001_init.sql:58). The empty string satisfies NOT NULL; it is the FOREIGN KEY that
-- fails, because no row in `users` has id `''`. The insert threw on every request into a
-- `waitUntil(...).catch(() => {})` — after the response had already been sent, so there
-- was nowhere left for it to surface.
--
-- The column is not the mistake; the table is. An anonymous page view HAS no user, and
-- `usage`'s own comment (0001_init.sql:59) says its events are `execution, api_call,
-- cron_run` — per-user, metered work. Relaxing `user_id` to nullable would mean rebuilding
-- a shipped table to weaken a constraint that is correct for every other row in it.
--
-- ## Why an aggregate, not one row per view
--
-- This is fed from an UNAUTHENTICATED route, so "one row per request" is a write an
-- anonymous caller controls the volume of: a script pointed at an agent page writes rows
-- until D1 fills up. A counter is bounded by construction — (agent × day × event) is at
-- most a few tens of rows a day for the whole catalog no matter how hard anyone pulls.
-- A determined bot can still inflate the NUMBER, which is true of every view counter ever
-- built; what matters is that it cannot inflate the STORAGE. `shouldCountView` drops the
-- self-identifying crawlers before the write, so the ordinary case is not counted at all.
--
-- The daily grain is not just for aggregation: it is what lets a later question ("did
-- views move after we changed the card?") be answered, which a single running total could
-- never do.
--
-- ## No FK, on purpose
--
-- Neither column references `agents`. Agent deletion is spread across three call sites
-- (`routes/agents.ts`, `routes/batch.ts`, `routes/admin-moderation.ts`), each hand-writing
-- its own cascade, and a view counter must never be the reason a delete fails. Those sites
-- clear this table alongside `usage`; a row that outlives its agent is unreachable anyway,
-- because every read is scoped by an agent id the caller was already authorised against.
--
-- ## No backfill
--
-- There is nothing to migrate. No `trial_start` row has ever existed, and every `view`
-- insert failed. History starts here.

CREATE TABLE IF NOT EXISTS agent_funnel_daily (
  agent_id TEXT NOT NULL,
  day      TEXT NOT NULL,                 -- UTC date, YYYY-MM-DD
  event    TEXT NOT NULL,                 -- 'view' | 'trial_start'
  hits     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, day, event)
);
