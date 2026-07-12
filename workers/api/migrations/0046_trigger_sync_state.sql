-- Per-trigger connector sync ledger. This prevents scheduled folder syncs from
-- re-importing the same Drive/WorkDrive file on every cron tick.

CREATE TABLE IF NOT EXISTS agent_trigger_sync_state (
  trigger_id      TEXT NOT NULL REFERENCES agent_triggers(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id),
  instance_id     TEXT NOT NULL REFERENCES agent_instances(id),
  provider        TEXT NOT NULL, -- google_drive | zoho_workdrive
  resource_id     TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  imported_doc_id TEXT,
  source_url      TEXT,
  imported_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (trigger_id, provider, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_trigger_sync_state_instance
  ON agent_trigger_sync_state(instance_id, provider, updated_at DESC);
