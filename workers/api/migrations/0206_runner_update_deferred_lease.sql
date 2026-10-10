-- #1008: a busy runner's local retry is bounded by a durable, observable lease.  A terminal
-- control-plane operation must never leave an unbounded timer that can restart a machine later.
ALTER TABLE runner_update_ops ADD COLUMN deferred_until INTEGER;
