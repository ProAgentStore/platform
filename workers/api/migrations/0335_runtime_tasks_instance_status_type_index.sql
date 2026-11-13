-- #1656: expireOrphanedRuntimeTasks looks up an instance's open tasks of a few types, and had only
-- (instance_id, updated_at) / (user_id, updated_at): every call read every task the instance ever had
-- (~7,200 rows). Not partial: a partial index is only used when the query repeats its WHERE verbatim,
-- and the open-status lists in these queries differ from one caller to the next.
CREATE INDEX IF NOT EXISTS idx_instance_runtime_tasks_instance_status_type
  ON instance_runtime_tasks(instance_id, status, type);
