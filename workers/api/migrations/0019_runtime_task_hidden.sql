-- Tombstone for cleared/deleted board tasks. The runner keeps tasks in its own
-- store and re-sends them on every /tasks poll, so a plain DELETE reappears. We
-- mark hidden=1 and filter them out of what the board reads.
ALTER TABLE instance_runtime_tasks ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
