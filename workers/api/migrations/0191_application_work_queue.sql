-- Approved pipeline work WAITS for a busy machine instead of dying on it (#974).
--
-- The local runner enforces one-at-a-time (`local-artifact/runtime.ts`: "already tailoring N
-- application(s)"; `local-apply/runtime.ts`: "already filling an application … one at a time"), and
-- the cloud turned ANY non-ok dispatch response into a terminal `runner_rejected` — so five leads
-- approved at once produced one run and four dead applications the owner had to retry by hand.
--
-- No new queue table: the run row already IS the queue entry. Both run tables are created with
-- `status DEFAULT 'queued'` and flipped to `running` only once the runner accepts the dispatch, and
-- both carry a UNIQUE(instance_id, request_id) index — so the queue has FIFO order (`created_at`),
-- an identity, and replay-idempotency already. A parallel table would have been a second source of
-- truth for "what is this run doing", kept in step by hand.
--
-- What was missing is only the retry bookkeeping, which is what these columns are:
--
--   attempts        dispatch attempts so far. Bounds the wait: a machine that is never free again
--                   must eventually settle the application rather than queue forever.
--   next_attempt_at when the drainer may try again. Set from the backoff ladder, so a busy machine
--                   is not re-asked every minute per queued item.
--   queued_reason   WHY it is waiting, in the owner's words — the board shows this, and it is what
--                   distinguishes "behind two others" from "your machine is offline".
ALTER TABLE local_artifact_runs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE local_artifact_runs ADD COLUMN next_attempt_at INTEGER;
ALTER TABLE local_artifact_runs ADD COLUMN queued_reason TEXT;

ALTER TABLE local_apply_runs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE local_apply_runs ADD COLUMN next_attempt_at INTEGER;
ALTER TABLE local_apply_runs ADD COLUMN queued_reason TEXT;

-- The drainer's read: the oldest due, queued run for one instance. Also the card's "position in
-- line", which counts the queued rows created before a given one.
CREATE INDEX IF NOT EXISTS idx_local_artifact_runs_queue
  ON local_artifact_runs(instance_id, status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_local_apply_runs_queue
  ON local_apply_runs(instance_id, status, next_attempt_at, created_at);
