-- #1017: a deferral stays visible after the entry leaves `pending`.
--
-- A deferral's only trace on the row was the waiting note `requeueEntry` writes into `stop_reason`, and
-- `finishQueueEntry` overwrites that column when the entry is admitted or fails. So once a `deferred`
-- event had failed to write, an admitted entry read `coverage: "complete"` with the transition missing.
-- `deferred_at` is set by `requeueEntry` and written by nothing else, so the evidence outlives every
-- later status. Additive and nullable: rows deferred before this column existed keep reading as before.
ALTER TABLE instance_objective_queue ADD COLUMN deferred_at INTEGER;
