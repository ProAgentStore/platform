-- Per-ticket budget and durable progress notes (#865, #757 slice 4).
--
-- ── Budget: a ticket OWNS one delegation pool
--
-- #757 left open whether a ticket becomes a delegation tree, sits inside one, or needs a third scope
-- in `reserve()`. It becomes one: `tickets.budget_id` names a `delegation_budgets` row (0061) that
-- every run started for the ticket draws on, instead of each run opening a fresh pool. So the
-- existing atomic draw — the affordability test inside the UPDATE's WHERE clause — is what bounds a
-- ticket across ALL its runs, concurrent ones included; a runaway ticket exhausts its own pool and
-- parks through the workflows' existing `markExhausted` path; and the account backstop that
-- `reserve()` checks first still applies on top. No third scope, no second reservation model.
--
-- `budget_limit_micros` is the owner's allowance for the ticket, read when its pool is opened.
-- NULL means the account's per-tree default, which is what a run got before this existed.
--
-- ── Progress: accumulated, not re-derived
--
-- `ticket_progress` is the ticket as the durable document of the work — each run's start, its
-- outcome, a budget park, a stall, an owner's resume — appended as they happen and kept after the
-- runs' own rows are cleared. It is deliberately a separate table from the human Q&A thread
-- (`ticket.question` / `ticket.answer` events), which it neither reads nor writes.
--
-- One row per (ticket, run, kind): a repeated run-end write records nothing new.
ALTER TABLE tickets ADD COLUMN budget_id TEXT;
ALTER TABLE tickets ADD COLUMN budget_limit_micros INTEGER CHECK (budget_limit_micros IS NULL OR budget_limit_micros > 0);

CREATE TABLE ticket_progress (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('started', 'finished', 'parked', 'stalled', 'resumed')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_ticket_progress_run_kind ON ticket_progress(ticket_id, run_id, kind) WHERE run_id IS NOT NULL;
CREATE INDEX idx_ticket_progress_ticket ON ticket_progress(ticket_id, instance_id, user_id, seq);
