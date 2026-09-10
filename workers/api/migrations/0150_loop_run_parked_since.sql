-- When this park STARTED, so a wedged one can be told from a working one (#790).
--
-- ── The defect
--
-- `runHealth` (lib/work-report.ts) short-circuits on the park before it ever reaches the heartbeat
-- test:
--
--     if (run.waitingReason) return "waiting";
--
-- That is right for the case it was written for — a `platform_interrupt` park is a journal replay
-- in flight and has nothing ticking BY DESIGN, so reading its silence as death would report a
-- recovery as a failure (#583). What it cannot express is a park that never ends. 0127 gave the row
-- `waiting_reason` and `waiting_until` but no answer to "how long has it been like this", so the
-- verdict had nothing to bound itself with and `stalled` became unreachable for any parked run, at
-- any age.
--
-- Measured live on run fe53a0c1: parked on `platform_interrupt`, instruction 1 of 15, zero progress
-- for 25+ minutes, `health` reporting `waiting` the entire time — which is the sentence that tells
-- an owner nothing is wrong. `waiting_reason` is cleared by exactly one statement (`recordIteration`,
-- and only when the iteration actually ADVANCES), so a run that never advances never clears it. The
-- run in the incident never advanced.
--
-- ── Why a column and not a derivation
--
-- The obvious candidates all move for other reasons and would restart the clock the bound exists to
-- run:
--
--   last_alive_at    the pause tick writes it on a timer — that is its JOB (0127), and it is what
--                    keeps a legitimately parked run alive past the sweeper's 3h cutoff. Deriving
--                    park age from it means a run that ticks forever is never old.
--   last_progress_at only moves on an advance, so it looks identical for "parked 30s into a long
--                    instruction" and "parked forever" — it dates the last ADVANCE, not the park.
--   waiting_until    null for the park in the incident. `platform_interrupt` has no knowable end
--                    (coding-pause.ts), which is exactly why it is the park that can hide.
--   started_at       dates the RUN. A run parked at hour three would read as parked for three hours.
--
-- So the park needs its own instant, written once when the park BEGINS and left alone while it
-- lasts. `recordLiveness` sets it only when the row is not already parked, so the repeated ticks a
-- park generates cannot push its own start date forward — the property none of the columns above
-- has, and the whole reason this one exists.
--
-- Cleared in the SAME statement that clears `waiting_reason` (`recordIteration`, on an advance) and
-- by `recordLiveness(wait: null)`. The invariant is: `parked_since IS NOT NULL` exactly when
-- `waiting_reason IS NOT NULL`, and `run-park-writers.test.ts` holds the production writers to it.
--
-- No backfill. Nullable, and every reader COALESCEs back through `last_alive_at` →
-- `last_progress_at` → `started_at` — the same fallback order `runHealth` and the sweeper already
-- share — so a run parked at deploy time is bounded from its heartbeat instead, which is
-- conservative in the safe direction (it can only make the bound EARLIER, never later).
ALTER TABLE agent_loop_runs ADD COLUMN parked_since INTEGER;

-- WHEN the stop was asked for, so an unanswered one can be enforced (#790, symptom 2).
--
-- `cancel_requested` is a BOOLEAN, and the sweeper's new cancel pass needs to know how long it has
-- gone unanswered — "the workflow has had its chance and did not take it" is a statement about
-- elapsed time, and a 0/1 flag cannot make it. Without this the only available proxy is
-- `last_alive_at`, which is also the heartbeat, so a run that stopped ticking the instant the
-- cancel arrived would be indistinguishable from one cancelled an hour ago.
--
-- The two are used TOGETHER rather than either alone, and the pass documents why: the cancel must
-- be old (this column) AND nothing may have been alive since to act on it (`last_alive_at`). A live
-- run in a long engine turn keeps heartbeating from the capture loop, and its cooperative stop must
-- be allowed to land by itself — killing it from outside would strand the budget reservation the
-- in-flight step is holding, which is the precise failure `requestCancel`'s own docstring exists to
-- prevent.
--
-- Written by `requestCancel`, cleared by nothing: a cancel is not withdrawable, and the column is
-- read only while `cancel_requested = 1`.
ALTER TABLE agent_loop_runs ADD COLUMN cancel_requested_at INTEGER;

-- The sweeper's second pass reads `waiting_reason IS NOT NULL AND parked_since < cutoff`, and the
-- cancel enforcer reads `cancel_requested = 1 AND status = 'running'`. Both are needle-in-haystack
-- queries over a table that is overwhelmingly finished runs, so both get the partial index that
-- `0068_open_run_indexes.sql` established the pattern for.
CREATE INDEX IF NOT EXISTS idx_agent_loop_runs_parked
  ON agent_loop_runs(parked_since) WHERE status = 'running' AND waiting_reason IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_loop_runs_cancelling
  ON agent_loop_runs(last_alive_at) WHERE status = 'running' AND cancel_requested = 1;
