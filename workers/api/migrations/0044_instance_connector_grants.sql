-- Per-instance access grants for account-level cloud connectors.
--
-- The OAuth connection remains user-wide in user_api_keys. This table narrows
-- which connected Drive/WorkDrive roots a specific agent instance may browse or
-- import from.

CREATE TABLE IF NOT EXISTS instance_connector_grants (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  resource_type TEXT NOT NULL DEFAULT 'folder',
  resource_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(instance_id, provider, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_instance_connector_grants_instance
  ON instance_connector_grants(instance_id, provider, created_at);

CREATE INDEX IF NOT EXISTS idx_instance_connector_grants_user
  ON instance_connector_grants(user_id, provider, created_at);
