-- Local/managed FAGS runtime registrations for browser-capable instances.
-- PAGS owns the brain and task orchestration; the registered FAGS runtime is
-- the browser capability/tool executor for one user's private instance.

CREATE TABLE instance_runtimes (
  instance_id TEXT PRIMARY KEY REFERENCES agent_instances(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  placement TEXT NOT NULL DEFAULT 'local',       -- local, managed
  endpoint_url TEXT NOT NULL,
  token_ciphertext BLOB,
  token_dek_wrapped BLOB,
  token_iv BLOB,
  token_plaintext TEXT,                          -- local/dev fallback when KEK is unavailable
  capabilities TEXT NOT NULL DEFAULT '[]',       -- JSON array
  runner_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'registered',     -- registered, online, offline
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_instance_runtimes_user ON instance_runtimes(user_id);
CREATE INDEX idx_instance_runtimes_status ON instance_runtimes(status, updated_at);
