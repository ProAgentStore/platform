-- Agent instances: one per (agent_template, subscriber)
-- Template = what the creator builds. Instance = what the client gets.

CREATE TABLE agent_instances (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),   -- the template
  user_id TEXT NOT NULL REFERENCES users(id),      -- the subscriber
  status TEXT NOT NULL DEFAULT 'active',            -- active, paused, canceled
  config TEXT NOT NULL DEFAULT '{}',                -- client-side overrides (welcome msg, etc.)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, user_id)                        -- one instance per user per agent
);

CREATE INDEX idx_instances_user ON agent_instances(user_id);
CREATE INDEX idx_instances_agent ON agent_instances(agent_id);

-- Subscriptions: tracks who pays for what
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL DEFAULT 'active',            -- active, canceled, past_due
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  canceled_at TEXT,
  UNIQUE(agent_id, user_id)
);

CREATE INDEX idx_subs_user ON subscriptions(user_id);
