-- Multiple local runners may serve one instance for Coder. The legacy
-- instance_runtimes row remains the default/browser runtime; this table stores
-- per-machine runtime registrations used for node-routed coding sessions.

CREATE TABLE IF NOT EXISTS instance_runtime_nodes (
  instance_id TEXT NOT NULL REFERENCES agent_instances(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  runner_node TEXT NOT NULL,
  placement TEXT NOT NULL DEFAULT 'local',
  endpoint_url TEXT NOT NULL,
  token_ciphertext BLOB,
  token_dek_wrapped BLOB,
  token_iv BLOB,
  token_plaintext TEXT,
  capabilities TEXT NOT NULL DEFAULT '[]',
  runner_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'registered',
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(instance_id, runner_node)
);

CREATE INDEX IF NOT EXISTS idx_instance_runtime_nodes_user
  ON instance_runtime_nodes(user_id);

CREATE INDEX IF NOT EXISTS idx_instance_runtime_nodes_status
  ON instance_runtime_nodes(instance_id, status, updated_at);
