-- Pipeline run records (issue #98, epic #94). One row per declarative-pipeline run
-- (workflows/pipeline-run.ts). Unlike agent_events (an append-only trace), a run record
-- has a LIFECYCLE — opened at kick with status 'running', its counts UPDATED as steps
-- run, and CLOSED at finish/crash with a terminal status — so counts are CAPTURED as the
-- runner walks, never reconstructed from the trace. Listed via GET
-- /v1/instances/:id/pipeline-runs and the MCP `list_pipeline_runs` tool (owner-scoped).
-- Per-record audit is NOT here: it rides on each output record's `audit` field in the
-- instance collection (the shape the /data tab detail already renders). Retention is
-- opportunistic (see lib/pipeline-runs.ts).
CREATE TABLE IF NOT EXISTS pipeline_runs (
  run_id       TEXT PRIMARY KEY,             -- the runId that also groups this run's trace events
  user_id      TEXT NOT NULL,               -- owner (scoping)
  instance_id  TEXT NOT NULL,               -- the agent instance the pipeline ran on
  pipeline     TEXT NOT NULL,               -- pipeline name
  trigger      TEXT NOT NULL DEFAULT 'api', -- 'chat' | 'api' | 'trigger'
  status       TEXT NOT NULL DEFAULT 'running', -- 'running' | 'completed' | 'failed' | 'interrupted'
  params       TEXT,                          -- JSON run params
  started_at   INTEGER NOT NULL,            -- ms epoch
  finished_at  INTEGER,                       -- ms epoch, null while running
  seen         INTEGER NOT NULL DEFAULT 0,  -- records the pipeline saw (final step output length)
  added        INTEGER NOT NULL DEFAULT 0,  -- records written to the sink
  skipped      INTEGER NOT NULL DEFAULT 0,  -- records skipped (non-object / dedupe)
  errors       INTEGER NOT NULL DEFAULT 0,  -- per-step + per-record failures
  detail       TEXT,                          -- terminal message (failure reason / summary)
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_instance ON pipeline_runs(instance_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_user ON pipeline_runs(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_created ON pipeline_runs(created_at);
