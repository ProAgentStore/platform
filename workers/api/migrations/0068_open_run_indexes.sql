-- Partial indexes for the stale-run sweeper (#207C).
--
-- The sweep runs every minute and asks the same question of both run tables: "which rows are still
-- open and have been quiet too long?". Without an index that is a full scan of every run ever
-- recorded, once a minute, growing forever.
--
-- PARTIAL on `status = 'running'` is the right shape rather than a plain index on `status`: a row
-- leaves the index the moment it is closed, so the index stays the size of the OPEN set (normally a
-- handful) no matter how much history accumulates behind it.
CREATE INDEX IF NOT EXISTS idx_agent_loop_runs_open
  ON agent_loop_runs(started_at) WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_open
  ON pipeline_runs(started_at) WHERE status = 'running';
