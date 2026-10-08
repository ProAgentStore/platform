-- Gmail-fed Job Search Scout (#995).  This is a source configuration and scan
-- cursor only: leads remain private records in each Scout Durable Object.
CREATE TABLE IF NOT EXISTS gmail_scout_configs (
  id           TEXT PRIMARY KEY,
  instance_id  TEXT NOT NULL UNIQUE REFERENCES agent_instances(id),
  pinned_email TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gmail_scout_configs_instance ON gmail_scout_configs(instance_id);

CREATE TABLE IF NOT EXISTS gmail_scout_scan_state (
  instance_id           TEXT PRIMARY KEY REFERENCES agent_instances(id),
  last_scan_at          TEXT,
  last_message_id_cursor TEXT,
  candidate_count       INTEGER NOT NULL DEFAULT 0,
  dedupe_count          INTEGER NOT NULL DEFAULT 0,
  failure_count         INTEGER NOT NULL DEFAULT 0,
  last_failure_at       TEXT,
  last_failure_message  TEXT
);
CREATE INDEX IF NOT EXISTS idx_gmail_scout_scan_state_last_scan ON gmail_scout_scan_state(last_scan_at DESC);
