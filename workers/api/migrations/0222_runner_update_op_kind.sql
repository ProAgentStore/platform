-- #1032: `runner_restart` is the same durable, single-flight operation as `runner_update`, without
-- the install. One table on purpose: the live-row unique index then forbids a restart and an update
-- running on one machine at once. Existing rows were all updates.
ALTER TABLE runner_update_ops ADD COLUMN kind TEXT NOT NULL DEFAULT 'update';
