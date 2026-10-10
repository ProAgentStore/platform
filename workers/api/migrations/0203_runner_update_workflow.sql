-- #1008: runner updates are owned by a durable Workflow, never by the HTTP request that asked
-- for one. The deterministic workflow id lets the minute recovery path safely retry enqueueing
-- before anything is dispatched to a machine.
ALTER TABLE runner_update_ops ADD COLUMN execution_owner TEXT;
ALTER TABLE runner_update_ops ADD COLUMN workflow_id TEXT;
ALTER TABLE runner_update_ops ADD COLUMN workflow_queued_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_runner_update_ops_workflow_queue
  ON runner_update_ops(execution_owner, phase, workflow_queued_at)
  WHERE state = 'running';
