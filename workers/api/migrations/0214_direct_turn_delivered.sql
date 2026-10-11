-- #1015: a reservation on the checkout is not a delivery.
--
-- 0211's direct-turn claim was released as soon as the runner said the engine was idle. Between the
-- claim and the send the engine IS idle — it has not received the message yet — so a watcher or an
-- admission probe that ran in that gap released the claim, and a queued successor could be admitted
-- onto a checkout whose next instruction was still on its way. `direct_turn_delivered_at` records
-- when the message reached (or may have reached) the engine; a claim with no delivery is kept
-- through an idle probe until it is stale (see `RESERVATION_STALE_MS` in lib/coding-ownership.ts).
ALTER TABLE coding_sessions ADD COLUMN direct_turn_delivered_at INTEGER;
