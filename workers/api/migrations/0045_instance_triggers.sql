-- First-class instance triggers: inbound webhooks and platform-dispatched crons.
-- Triggers are per user-owned instance. The platform stores webhook secrets and
-- schedules, then dispatches to the instance Durable Object through a narrow set
-- of actions (no arbitrary shell/API proxy).

CREATE TABLE IF NOT EXISTS agent_triggers (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  instance_id   TEXT NOT NULL REFERENCES agent_instances(id),
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,                 -- webhook | cron
  action        TEXT NOT NULL,                 -- create_task | add_knowledge | log_event
  enabled       INTEGER NOT NULL DEFAULT 1,
  secret_token  TEXT UNIQUE,                   -- webhook bearer path token
  schedule      TEXT,                          -- cron expression / @daily / every 15 minutes
  config        TEXT NOT NULL DEFAULT '{}',
  last_run_at   TEXT,
  next_run_at   TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_triggers_user ON agent_triggers(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_triggers_instance ON agent_triggers(instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_triggers_due ON agent_triggers(type, enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_agent_triggers_secret ON agent_triggers(secret_token);

CREATE TABLE IF NOT EXISTS agent_trigger_events (
  id          TEXT PRIMARY KEY,
  trigger_id  TEXT NOT NULL REFERENCES agent_triggers(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  instance_id TEXT NOT NULL REFERENCES agent_instances(id),
  type        TEXT NOT NULL,                   -- webhook | cron | manual
  status      TEXT NOT NULL,                   -- received | running | succeeded | failed
  message     TEXT,
  payload     TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_trigger_events_trigger ON agent_trigger_events(trigger_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_trigger_events_instance ON agent_trigger_events(instance_id, created_at DESC);
