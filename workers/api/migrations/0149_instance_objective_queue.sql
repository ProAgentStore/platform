-- Queued follow-up objectives, so a finished run starts the next one itself (#788).
--
-- ── The defect
--
-- `coding_loop_start` on a busy instance is a 409: `loop-drivers.ts` fails `claimSessionDriver`
-- and answers "<repo> is already being worked on". That refusal is correct — two Pilots typing
-- into one tmux pane is #208 — but it left the caller with only two moves: poll `coding_loop_status`
-- until the run frees up, or stop the live run early. Both need a human present at the exact moment
-- the lock clears, and the reported case is the one where nobody is: a self-review run in flight
-- with a second, unrelated build task that should start straight after it.
--
-- ── Why a table, and not a field on `agent_loop_runs`
--
-- A queued objective is not a run. It has no `run_id` to poll, no budget pool, no iteration count,
-- no health — those all come into existence at the moment it STARTS, which is the whole point of
-- queueing. Writing it as a `running`-less row on `agent_loop_runs` would put a thing with none of
-- that vocabulary in front of every reader of `listLoopRuns`, `runHealth` and `check_delegation`,
-- each of which would then need "…unless it never started" appended to it. `finishLoopRun` is
-- documented as the ONLY terminal write to that table (lib/status-domain.ts) and a second lifecycle
-- sharing the rows is precisely how that stops being true.
--
-- ── KEYED (instance_id, repo_id), and repo_id NULL means "any"
--
-- The lock this works around is per SESSION DRIVER, i.e. per repo: `pickLoopRepo` chooses the repo
-- and `claimSessionDriver` claims that repo's session. A queue keyed only by instance would park a
-- follow-up for repo B behind a run on repo A that never contended with it, on exactly the
-- multi-repo Coder #374 exists for. NULL is for the callers that genuinely mean the agent rather
-- than a checkout — a chat-driver loop has no repo at all — and a NULL entry is eligible for
-- whichever repo drains next.
--
-- ── `status`, and why `started` is not `done`
--
--   pending    waiting for the lock to clear. The only status a caller may cancel.
--   running    claimed by a drain and being started right now. A holding state measured in
--              milliseconds; it exists so two concurrent drains cannot claim one entry.
--   started    a run was created for it. `run_id` says which, and that run's own record is where
--              the outcome lives from then on. Not "done": the WORK is only beginning.
--   cancelled  the caller withdrew it before it started.
--   failed     the drain tried and could not start it — no runner, no repo, or the budget refused.
--              `stop_reason` carries the driver's own sentence, because an entry that vanishes
--              without one is the "if I forget to check back, the request is just lost" the issue
--              is about.
--
-- No retention sweep. An entry is small, terminal states are final, and the queue's history is how
-- an owner answers "what did I line up and what became of it".
CREATE TABLE IF NOT EXISTS instance_objective_queue (
  id             TEXT PRIMARY KEY,
  instance_id    TEXT NOT NULL,
  repo_id        TEXT,                          -- NULL = any repo on this instance (see above)
  user_id        TEXT NOT NULL,
  objective      TEXT NOT NULL,
  max_iterations INTEGER,                       -- NULL keeps the driver's default at start time
  metadata       TEXT,                          -- caller-owned JSON; the platform never writes it
  status         TEXT NOT NULL DEFAULT 'pending',
  stop_reason    TEXT,
  run_id         TEXT,                          -- the run this entry became, once it starts
  created_at     INTEGER NOT NULL,              -- ms epoch; the FIFO order
  started_at     INTEGER,
  finished_at    INTEGER
);

-- The dequeue predicate exactly: instance, then repo (or NULL), then pending, oldest first.
CREATE INDEX IF NOT EXISTS idx_instance_objective_queue_fifo
  ON instance_objective_queue(instance_id, repo_id, status, created_at);
