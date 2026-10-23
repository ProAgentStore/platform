-- #1318: runs that stopped on `provider_credit` continue by themselves once the owner's key works again.
--
-- The durable guard lives on the STOPPED run, so a second recovery event, a cron overlap or the one-time
-- backfill can never continue it twice: a pass claims a run with one conditional UPDATE (auto_resume_at IS NULL),
-- starts the successor, then records its id. A claim that never got a successor (a crash between the two) is
-- released after ten minutes. A refusal that waiting fixes (repo busy, machine away) releases the claim with a
-- backed-off retry time; anything else, or too many tries, ends it as 'gave_up' with the reason, never silently.
ALTER TABLE agent_loop_runs ADD COLUMN auto_resume_at INTEGER;
ALTER TABLE agent_loop_runs ADD COLUMN auto_resume_state TEXT;
ALTER TABLE agent_loop_runs ADD COLUMN auto_resume_successor TEXT;
ALTER TABLE agent_loop_runs ADD COLUMN auto_resume_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_loop_runs ADD COLUMN auto_resume_next_at INTEGER;
ALTER TABLE agent_loop_runs ADD COLUMN auto_resume_note TEXT;
-- On the SUCCESSOR: the stopped run it continued automatically.
ALTER TABLE agent_loop_runs ADD COLUMN auto_resumed_from TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_loop_runs_credit_resume ON agent_loop_runs(stop_reason, auto_resume_at, finished_at);

-- Probing a failing key (the lightweight alternative to waiting for the next real call): 5m, 15m, 1h, then 6h.
ALTER TABLE provider_account_holds ADD COLUMN probe_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE provider_account_holds ADD COLUMN next_probe_at INTEGER;

-- One row, set when the deploy's one-time backfill has run (the same handler as the cron, so it is also idempotent).
CREATE TABLE IF NOT EXISTS credit_auto_resume_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  backfilled_at INTEGER NOT NULL,
  backfill_resumed INTEGER NOT NULL DEFAULT 0
);
