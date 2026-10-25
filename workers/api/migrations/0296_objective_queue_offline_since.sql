-- #1189: a queued objective waiting on an offline runner has an upper bound.
--
-- Since #1161 an entry whose start is refused with `runner_offline` goes back to `pending` and is drained when the relay
-- reconnects. A machine that never comes back (or was never registered) kept its entries pending for ever, with nobody told.
-- `offline_since` is when the entry FIRST began waiting on an offline runner in this unbroken stretch: set by the first
-- `runner_offline` deferral, kept by later ones, cleared by a deferral for any other reason (the machine was back and the
-- wait is something else). Past `QUEUE_OFFLINE_MAX_MS` (lib/objective-queue-offline.ts) the entry fails with a sentence that
-- names the bound.
ALTER TABLE instance_objective_queue ADD COLUMN offline_since INTEGER;
