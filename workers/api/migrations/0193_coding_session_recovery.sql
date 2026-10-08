-- Ownership of unfinished coding work (#984).
--
-- A run for issue #978 was closed `needs_human / interrupted` after its orchestrator stopped
-- heartbeating. Its coding session stayed `active`, its engine kept holding the #978 command, and
-- eight uncommitted files stayed in the checkout. The queue then started #982 in that same session:
-- the durable active-run record said #982 while the CLI was executing #978's instruction, which is
-- how issue A's changes can be committed, pushed or closed under issue B.
--
-- Nothing in the schema recorded that the work in that checkout BELONGED to a run. The session knew
-- which issue it was opened for (`issue_number`, 0020) but not that a closed run had left work
-- behind unaccounted for, so there was nothing for an admission check to read and nothing for a
-- human to recover from.
--
-- These columns are that record: a CLAIM, raised when the platform — not the run itself — closes a
-- run holding a session, naming the run, the issue and the objective that own what is in the tree.
-- A claim blocks a DIFFERENT objective from starting in that session or checkout, and is released
-- either by confirming the tree clean and the engine stopped, or by a run that explicitly continues
-- the claimed issue. Nothing is ever discarded on the platform's initiative.
--
-- `recovery_state`/`recovery_detail` cache the last probed verdict so a listing (the objective
-- queue, the board) can report `stalled` vs `interrupted awaiting recovery` without reaching a
-- machine. They are a cache of an observation, never the authority: the admission check always
-- re-probes.

ALTER TABLE coding_sessions ADD COLUMN recovery_run_id TEXT;
ALTER TABLE coding_sessions ADD COLUMN recovery_reason TEXT;
ALTER TABLE coding_sessions ADD COLUMN recovery_issue INTEGER;
ALTER TABLE coding_sessions ADD COLUMN recovery_objective TEXT;
ALTER TABLE coding_sessions ADD COLUMN recovery_at INTEGER;
ALTER TABLE coding_sessions ADD COLUMN recovery_state TEXT;
ALTER TABLE coding_sessions ADD COLUMN recovery_detail TEXT;
ALTER TABLE coding_sessions ADD COLUMN recovered_by_run_id TEXT;
-- When the claim was answered. A separate column from `recovered_by_run_id` because a claim can be
-- answered with NO run recovering it — the engine is stopped and the tree is clean, so there was
-- nothing to recover — and "released" must not be expressible only as "somebody took it over".
ALTER TABLE coding_sessions ADD COLUMN recovery_released_at INTEGER;

-- The admission read: "is there an unreleased claim on this repo's checkout", newest first. Partial
-- so it indexes only the rows that are claims, which is a handful at any moment.
CREATE INDEX IF NOT EXISTS idx_coding_sessions_recovery
    ON coding_sessions(repo_id, recovery_at) WHERE recovery_run_id IS NOT NULL AND recovery_released_at IS NULL;
