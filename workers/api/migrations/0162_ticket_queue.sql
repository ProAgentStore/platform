-- The opt-in ticket queue (#864, #757 slice 3): autonomous pickup of first-class tickets.
--
-- Two decisions live in data, and both default to "no":
--
--   • Whether an INSTANCE runs a queue at all — `ticket_queues.enabled`, and no row means off. PAGS
--     hosts the agents that repair PAGS; a queue that defaulted on could start unattended work on
--     this platform's own repo on upgrade day (#757 §7). This migration enables nothing.
--
--   • Whether a TICKET may be picked up without a person — `tickets.pickup_authority`. `human` (the
--     default, and every existing ticket) means a person must release it; `agent` means the queue may
--     start it on its own (#757 §3). It is a field on the ticket, not the approval gate: approving is
--     a human acting, and the queue is not a human.
--
-- `queue_picked_at` is the claim. The queue picks a ticket by setting it WHERE it is still NULL, so
-- two sweeps racing for the same ticket cannot both win, and a ticket the queue has taken once is
-- never re-taken on its own — a run that failed or parked comes back only when a person re-queues it.
-- `queue_run_id` is the run it started; `queue_note` says why a claimed ticket did not start.
--
-- `ticket_queues.lease_*` is the per-instance single flight for the PICKUP itself: two cron ticks
-- overlapping on one instance cannot both pass the "is a run already going" check and start two.
ALTER TABLE tickets ADD COLUMN pickup_authority TEXT NOT NULL DEFAULT 'human' CHECK (pickup_authority IN ('human', 'agent'));
ALTER TABLE tickets ADD COLUMN queue_picked_at TEXT;
ALTER TABLE tickets ADD COLUMN queue_run_id TEXT;
ALTER TABLE tickets ADD COLUMN queue_note TEXT;
CREATE INDEX idx_tickets_queue ON tickets(instance_id, user_id, pickup_authority, queue_picked_at);

CREATE TABLE ticket_queues (
  instance_id TEXT PRIMARY KEY REFERENCES agent_instances(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  lease_holder TEXT,
  lease_until INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ticket_queues_enabled ON ticket_queues(enabled);
