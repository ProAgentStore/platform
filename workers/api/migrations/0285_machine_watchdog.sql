-- #1320: the always-on control channel. A small watchdog service on each machine holds its own connection to the platform,
-- independent of the main `pags up` runner, so a machine can be updated, restarted, rolled back and asked allow-listed
-- diagnostics even when the runner is dead. It heartbeats its status here and is handed queued commands in the answer.
CREATE TABLE IF NOT EXISTS machine_watchdog_status (
  user_id     TEXT NOT NULL,
  machine_id  TEXT NOT NULL,
  reported_at INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  version     TEXT,
  status_json TEXT NOT NULL,
  PRIMARY KEY (user_id, machine_id)
);

CREATE TABLE IF NOT EXISTS machine_watchdog_commands (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  machine_id   TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('status', 'update', 'restart', 'rollback', 'diagnose')),
  args         TEXT NOT NULL DEFAULT '{}',
  state        TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'delivered', 'done', 'failed', 'expired')),
  requested_by TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER,
  finished_at  INTEGER,
  result       TEXT
);
CREATE INDEX IF NOT EXISTS idx_watchdog_commands_machine ON machine_watchdog_commands(user_id, machine_id, state, created_at);
