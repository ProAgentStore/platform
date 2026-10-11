-- #1017: count deferrals, and tie each `deferred` event to the deferral it records.
--
-- `deferred_at` (0216) proves AT LEAST one deferral: it holds the latest time, so an entry deferred twice
-- with one of its two `deferred` events lost still read `complete`.
--
-- `deferral_count` is set to 0 when a row is queued and incremented by `requeueEntry`, but only when that
-- call actually moved a claimed row back to pending, so a retry that changes nothing is not a deferral.
-- Rows that existed before this migration are deliberately left NULL ("count unknown"), not backfilled:
-- a row known to be deferred has no record of HOW MANY times, and a row with no surviving marker may have
-- been deferred before 0216. Backfilling either would make history look complete when it is not.
ALTER TABLE instance_objective_queue ADD COLUMN deferral_count INTEGER;

-- The ordinal of the deferral a `deferred` event records (1, 2, …). The unique index makes a repeated
-- write of the same deferral fail and be dropped by the best-effort writer, so it is counted once.
-- Events written before this migration are NULL and are never matched to an ordinal.
ALTER TABLE objective_lifecycle_events ADD COLUMN deferral_seq INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_objective_lifecycle_deferral_seq
  ON objective_lifecycle_events(queue_entry_id, deferral_seq)
  WHERE event = 'deferred' AND deferral_seq IS NOT NULL;
