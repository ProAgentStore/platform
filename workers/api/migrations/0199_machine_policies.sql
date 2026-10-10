-- Per-owner policy for a physical runner.  Hostnames are routing labels and can change;
-- machine_id is minted once by the CLI, so policy is deliberately never keyed by runner_node.
CREATE TABLE IF NOT EXISTS machine_policies (
  user_id TEXT NOT NULL REFERENCES users(id),
  machine_id TEXT NOT NULL,
  auto_update INTEGER NOT NULL DEFAULT 0 CHECK (auto_update IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'disabled',
  latest_version TEXT,
  last_attempt_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (user_id, machine_id)
);

-- Update history used to be hostname scoped.  Keep node for old clients and audit readability,
-- while new callers claim/read by the stable physical-machine key.
ALTER TABLE runner_update_ops ADD COLUMN machine_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_runner_update_ops_live_machine
  ON runner_update_ops(user_id, machine_id) WHERE state = 'running' AND machine_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runner_update_ops_machine
  ON runner_update_ops(user_id, machine_id, created_at DESC);
