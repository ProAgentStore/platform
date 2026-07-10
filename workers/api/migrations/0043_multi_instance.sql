-- Allow MULTIPLE instances of the same agent per user (e.g. two Doc Chat
-- libraries with different documents). The one-instance rule was a table-level
-- UNIQUE(agent_id, user_id) — SQLite can't drop a table constraint in place, so
-- rebuild the table without it. Instances are distinguished by
-- config.displayName (auto-numbered "Agent N" on subscribe; renameable via
-- PUT /v1/instances/:id/name).
--
-- defer_foreign_keys: several tables (runtime task mirror, coding workspaces,
-- coding timeline) have FKs referencing agent_instances(id) — deferring lets the
-- drop+rename happen atomically within this migration without FK violations.

-- NOTE: must be `true` — D1's PRAGMA allowlist does not accept `on` here, and a
-- silently-ignored defer makes the DROP violate FKs at commit (seen live: the
-- first deploy of this migration rolled back with code 7500).
PRAGMA defer_foreign_keys = true;

CREATE TABLE agent_instances_new (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),   -- the template
  user_id TEXT NOT NULL REFERENCES users(id),      -- the subscriber
  status TEXT NOT NULL DEFAULT 'active',            -- active, paused, canceled
  config TEXT NOT NULL DEFAULT '{}',                -- client-side overrides (displayName, settings, …)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO agent_instances_new (id, agent_id, user_id, status, config, created_at, updated_at)
  SELECT id, agent_id, user_id, status, config, created_at, updated_at FROM agent_instances;

DROP TABLE agent_instances;
ALTER TABLE agent_instances_new RENAME TO agent_instances;

-- DROP TABLE removed these — recreate.
CREATE INDEX idx_instances_user ON agent_instances(user_id);
CREATE INDEX idx_instances_agent ON agent_instances(agent_id);
