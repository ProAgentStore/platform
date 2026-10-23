-- #1315: auto-pickup reserves the allowance and the issue ATOMICALLY before it enqueues.
--
-- Two overlapping wakes (the timer sweep and a run's terminal step) could both pass the idle, cap and
-- eligibility reads before either wrote anything, queueing the same issue twice and consuming two starts
-- of a one-start allowance. The 'started' log row IS the allowance, so it is now inserted first, by one
-- conditional statement (cap not reached, no live reservation or queued/running run for the issue), and
-- the objective is enqueued only by the wake that won. `reserved = 1` marks a row whose objective is not
-- yet enqueued; it is cleared, with the queue entry's id recorded, once it is. A reservation left behind
-- by a crash is recovered (linked to its entry if one exists, otherwise deleted so the allowance is not
-- leaked). Rows written before this migration have reserved = 0: they are complete starts.
ALTER TABLE auto_pickup_log ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auto_pickup_log ADD COLUMN entry_id TEXT;
