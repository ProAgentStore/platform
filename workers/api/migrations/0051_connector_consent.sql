-- Write-consent for connector tools (issue #90). Reads via a connected system are
-- allowed once the connector is connected; WRITES (create issue/PR, append to a
-- sheet, …) operate with the user's real credentials, so they require explicit
-- per-instance consent for that connector's write scope. A row here = "this instance
-- may use <connector> tools of <scope>." Enforced in runRegistryTool (fail-closed:
-- no row → no write).
CREATE TABLE IF NOT EXISTS instance_connector_consent (
  instance_id TEXT NOT NULL REFERENCES agent_instances(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  connector   TEXT NOT NULL,   -- e.g. 'github'
  scope       TEXT NOT NULL,   -- 'write' (reads don't need consent)
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (instance_id, connector, scope)
);
CREATE INDEX IF NOT EXISTS idx_connector_consent_user ON instance_connector_consent(user_id, created_at DESC);
