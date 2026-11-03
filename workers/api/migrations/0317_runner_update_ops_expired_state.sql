-- #1456: a `scheduled` deferred update's lease can elapse with no confirmed restart, and that needs
-- an EXPLICIT terminal state distinct from `scheduled` — until now `scheduled` was the only state
-- neither `failStaleUpdateOps` (running only) nor `reconcileUnreachableUpdateOp` (unreachable only)
-- ever revisited, so a deferred update reported "scheduled" forever past its own lease.
--
-- SQLite has no ALTER TABLE for a CHECK constraint, so the table is rebuilt with 'expired' added to
-- the state vocabulary. Every column, default and index from 0194/0199/0202/0203/0206/0222 is
-- preserved exactly.
CREATE TABLE runner_update_ops_new (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id),
  node               TEXT NOT NULL,
  machine_id         TEXT,
  state              TEXT NOT NULL DEFAULT 'running'
                     CHECK (state IN ('running', 'scheduled', 'expired', 'restarting', 'restarted',
                                      'up_to_date', 'would_update', 'refused', 'unsupported',
                                      'unreachable', 'failed')),
  phase              TEXT NOT NULL DEFAULT 'claimed',
  kind               TEXT NOT NULL DEFAULT 'update',
  current_version    TEXT,
  latest_version     TEXT,
  final_version      TEXT,
  detail             TEXT,
  reason             TEXT,
  held               TEXT NOT NULL DEFAULT '[]',
  reattached         TEXT NOT NULL DEFAULT '[]',
  missing            TEXT NOT NULL DEFAULT '[]',
  waiting_for        TEXT NOT NULL DEFAULT '[]',
  restarted_by       TEXT,
  supervisor         TEXT,
  requested_by       TEXT NOT NULL DEFAULT 'owner',
  dry_run            INTEGER NOT NULL DEFAULT 0,
  execution_owner    TEXT,
  workflow_id        TEXT,
  workflow_queued_at INTEGER,
  deferred_until     INTEGER,
  reconciliation     TEXT,
  reconciled_at      INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  ended_at           INTEGER
);

INSERT INTO runner_update_ops_new (
  id, user_id, node, machine_id, state, phase, kind, current_version, latest_version, final_version,
  detail, reason, held, reattached, missing, waiting_for, restarted_by, supervisor, requested_by,
  dry_run, execution_owner, workflow_id, workflow_queued_at, deferred_until, reconciliation,
  reconciled_at, created_at, updated_at, ended_at
)
SELECT
  id, user_id, node, machine_id, state, phase, kind, current_version, latest_version, final_version,
  detail, reason, held, reattached, missing, waiting_for, restarted_by, supervisor, requested_by,
  dry_run, execution_owner, workflow_id, workflow_queued_at, deferred_until, reconciliation,
  reconciled_at, created_at, updated_at, ended_at
FROM runner_update_ops;

DROP TABLE runner_update_ops;
ALTER TABLE runner_update_ops_new RENAME TO runner_update_ops;

CREATE UNIQUE INDEX IF NOT EXISTS idx_runner_update_ops_live
  ON runner_update_ops(user_id, node) WHERE state = 'running';
CREATE INDEX IF NOT EXISTS idx_runner_update_ops_node ON runner_update_ops(user_id, node, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runner_update_ops_live_machine
  ON runner_update_ops(user_id, machine_id) WHERE state = 'running' AND machine_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runner_update_ops_machine
  ON runner_update_ops(user_id, machine_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runner_update_ops_workflow_queue
  ON runner_update_ops(execution_owner, phase, workflow_queued_at)
  WHERE state = 'running';
