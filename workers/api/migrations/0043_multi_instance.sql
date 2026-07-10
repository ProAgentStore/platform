-- Allow MULTIPLE instances of the same agent per user (e.g. two Doc Chat
-- libraries with different documents). The one-instance rule was a table-level
-- UNIQUE(agent_id, user_id) — SQLite can't drop a table constraint in place, so
-- the table is rebuilt without it. Instances are distinguished by
-- config.displayName (auto-numbered "Agent N" on subscribe; renameable via
-- PUT /v1/instances/:id/name).
--
-- D1 war story (two rolled-back deploys, code 7500): `PRAGMA defer_foreign_keys`
-- DOES span the migration's statements (probed live), and prod data was verified
-- clean — the failing ingredient was `ALTER TABLE … RENAME TO` in the classic
-- rebuild recipe. So: copy to a constraint-free holding table, DROP, re-CREATE
-- under the SAME name (no rename), copy back, drop the holding table. This exact
-- shape was probed successfully against prod D1 before landing here.

PRAGMA defer_foreign_keys = true;

CREATE TABLE agent_instances_mig AS
  SELECT id, agent_id, user_id, status, config, created_at, updated_at FROM agent_instances;

DROP TABLE agent_instances;

CREATE TABLE agent_instances (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),   -- the template
  user_id TEXT NOT NULL REFERENCES users(id),      -- the subscriber
  status TEXT NOT NULL DEFAULT 'active',            -- active, paused, canceled
  config TEXT NOT NULL DEFAULT '{}',                -- client-side overrides (displayName, settings, …)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO agent_instances (id, agent_id, user_id, status, config, created_at, updated_at)
  SELECT id, agent_id, user_id, status, config, created_at, updated_at FROM agent_instances_mig;

DROP TABLE agent_instances_mig;

-- DROP TABLE removed these — recreate.
CREATE INDEX idx_instances_user ON agent_instances(user_id);
CREATE INDEX idx_instances_agent ON agent_instances(agent_id);
