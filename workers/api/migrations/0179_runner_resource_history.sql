-- A machine's resource HISTORY, not only its latest sample (#924).
--
-- 0173 stored the newest heartbeat sample per machine row, which answers "is it fine now" and
-- nothing about a relay drop that already happened: by the time anyone asks, the spike is over.
-- Two tiers, written from the same 30s heartbeat:
--
--   dense  — every sample, kept ~2 hours: "what was the machine doing in the minutes before 06:04".
--   coarse — one row per 5-minute bucket, the bucket's worst readings (max load, min free memory and
--            disk, max sessions, max relay round trip), kept ~24 hours: "has it been running hotter
--            for hours as agents piled on".
--
-- Keyed by the owner and the machine NAME the heartbeat came under (`runner_node`); a machine with
-- several names is read across all of them. `at` is the runner's sample time (dense) or the bucket
-- start (coarse), epoch ms. Every agent on a machine heartbeats the SAME sample, so the primary key
-- also de-duplicates them — one row per sample, not one per agent.
CREATE TABLE runner_resource_samples (
  user_id TEXT NOT NULL,
  node TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('dense', 'coarse')),
  at INTEGER NOT NULL,
  sample TEXT NOT NULL,
  PRIMARY KEY (user_id, node, tier, at)
);
