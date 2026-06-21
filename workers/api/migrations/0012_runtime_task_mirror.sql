-- Durable PAGS mirror of FAGS runtime task snapshots and task events.
-- FAGS remains the execution plane; PAGS stores enough state for account UI,
-- MCP inspection, and audit/history when a local runtime is stopped.

CREATE TABLE instance_runtime_tasks (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES agent_instances(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_instance_runtime_tasks_instance ON instance_runtime_tasks(instance_id, updated_at);
CREATE INDEX idx_instance_runtime_tasks_user ON instance_runtime_tasks(user_id, updated_at);
CREATE INDEX idx_instance_runtime_tasks_status ON instance_runtime_tasks(status, updated_at);

CREATE TABLE instance_runtime_task_events (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES agent_instances(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  task_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_instance_runtime_task_events_instance ON instance_runtime_task_events(instance_id, created_at);
CREATE INDEX idx_instance_runtime_task_events_user ON instance_runtime_task_events(user_id, created_at);
CREATE INDEX idx_instance_runtime_task_events_task ON instance_runtime_task_events(task_id, created_at);
