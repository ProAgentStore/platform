-- Agent config versions: snapshot state for rollback
CREATE TABLE agent_versions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  version_num INTEGER NOT NULL,
  state_snapshot TEXT NOT NULL,     -- JSON of AgentState at time of save
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_versions_agent ON agent_versions(agent_id, version_num);
