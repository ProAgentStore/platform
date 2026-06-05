-- ProAgentStore initial schema
-- Users, agents, executions, usage tracking

CREATE TABLE users (
  id TEXT PRIMARY KEY,                     -- GitHub user ID
  github_login TEXT NOT NULL,
  github_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  roles TEXT NOT NULL DEFAULT '["user"]',  -- JSON array: user, creator, admin
  stripe_customer_id TEXT,
  subscription_status TEXT DEFAULT 'none', -- none, active, canceled, past_due
  subscription_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  slug TEXT NOT NULL UNIQUE,               -- URL-safe identifier
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general', -- general, chat, code, data, creative, productivity
  icon TEXT NOT NULL DEFAULT '',
  icon_bg TEXT NOT NULL DEFAULT '#7c3aed',
  model TEXT NOT NULL DEFAULT '',           -- Workers AI model ID
  visibility TEXT NOT NULL DEFAULT 'draft', -- draft, published, unlisted
  status TEXT NOT NULL DEFAULT 'inactive',  -- inactive, active, error
  worker_name TEXT,                         -- CF Worker name (when deployed)
  cron_schedule TEXT,                       -- cron expression (if scheduled)
  config TEXT NOT NULL DEFAULT '{}',        -- JSON agent config
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_agents_owner ON agents(owner_id);
CREATE INDEX idx_agents_category ON agents(category);
CREATE INDEX idx_agents_visibility ON agents(visibility);

CREATE TABLE agent_executions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_executions_agent ON agent_executions(agent_id, created_at);
CREATE INDEX idx_executions_user ON agent_executions(user_id, created_at);

CREATE TABLE usage (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  event TEXT NOT NULL,                      -- execution, api_call, cron_run
  metadata TEXT NOT NULL DEFAULT '{}',      -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_usage_agent ON usage(agent_id, created_at);
CREATE INDEX idx_usage_payout ON usage(agent_id, created_at);
