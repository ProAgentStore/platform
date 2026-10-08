-- #990: a runner update is a DURABLE operation, not the reply to one HTTP request.
--
-- The live failure: `runner_update` on an idle `Macmini.modem` returned
-- `outcome: "unknown", confirmation.reason: "deadline-exceeded"` twice, and the node stayed
-- connected, idle and on 0.4.84 with no outcome and no error recorded anywhere. The reason is
-- structural: `updateRunnerNode` can block for ~205s (a 115s relay command plus a 90s re-attach
-- wait) while the MCP seam's confirmation deadline is 20s, and on expiry it aborts the request —
-- which cancels the Worker and kills the work mid-flight. Nothing in that function persisted
-- anything, so a lost reply made the operation UNKNOWABLE, which is the property this table ends.
--
-- One row per attempt. The in-flight one is the single-flight claim (`idx_runner_update_ops_live`),
-- so a retried call joins the operation already running instead of starting a second install.
CREATE TABLE IF NOT EXISTS runner_update_ops (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  -- The machine as the caller named it, normalized. Not a foreign key: a node may be forgotten
  -- while the record of what was done to it stays readable.
  node          TEXT NOT NULL,
  -- `running` is the only non-terminal state; the rest are the terminal vocabulary #990 names.
  state         TEXT NOT NULL DEFAULT 'running'
                CHECK (state IN ('running', 'scheduled', 'restarting', 'restarted', 'up_to_date',
                                 'would_update', 'refused', 'unsupported', 'unreachable', 'failed')),
  -- What the machine reported about itself, and the version the platform recorded after a restart.
  current_version TEXT,
  latest_version  TEXT,
  final_version   TEXT,
  -- The owner-facing sentence, and the structured reason a reader can branch on.
  detail        TEXT,
  reason        TEXT,
  -- Agents holding a socket when it started, those re-attached, those still missing, the engines
  -- it is waiting for. JSON arrays; ids and bounded detail only.
  held          TEXT NOT NULL DEFAULT '[]',
  reattached    TEXT NOT NULL DEFAULT '[]',
  missing       TEXT NOT NULL DEFAULT '[]',
  waiting_for   TEXT NOT NULL DEFAULT '[]',
  -- How the machine brought itself back, and whether its `pags up` stayed on old code (#860).
  restarted_by  TEXT,
  supervisor    TEXT,
  requested_by  TEXT NOT NULL DEFAULT 'owner',
  dry_run       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  ended_at      INTEGER
);

-- The single-flight claim: at most ONE live operation per (owner, machine).
CREATE UNIQUE INDEX IF NOT EXISTS idx_runner_update_ops_live
  ON runner_update_ops(user_id, node) WHERE state = 'running';
-- The read path: this machine's latest attempt, and the owner's recent ones.
CREATE INDEX IF NOT EXISTS idx_runner_update_ops_node ON runner_update_ops(user_id, node, created_at DESC);
