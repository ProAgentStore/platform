-- Agent-to-agent connections — the "pump" (epic: two-agents architecture). A connection is
-- a single edge: when a SOURCE instance emits a typed event (e.g. "lead.created"), deliver
-- the event payload to a TARGET instance by running a trigger action (insert_record /
-- run_pipeline / create_task / add_knowledge). This is how one agent feeds another WITHOUT
-- sharing storage: instances stay isolated (the marketplace invariant — a creator never sees
-- a client's store), data flows as events, and each agent owns its own copy + its own state.
--
-- Delivery reuses lib/triggers.ts `executeTriggerAction` (the same 6 actions a webhook trigger
-- fires), so a connection is transport-only — no new action surface. Both instances MUST be
-- owned by the same user_id (enforced at create time): you can only wire YOUR OWN agents.
CREATE TABLE IF NOT EXISTS agent_connections (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,               -- owner (both instances belong to them)
  source_instance_id  TEXT NOT NULL,               -- emits the event
  event_type          TEXT NOT NULL,               -- e.g. 'lead.created'
  target_instance_id  TEXT NOT NULL,               -- receives the payload
  action              TEXT NOT NULL,               -- trigger action: insert_record | run_pipeline | create_task | add_knowledge
  config              TEXT,                          -- JSON: action config (collection, pipeline, title, …)
  enabled             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The dispatch hot path: "who consumes this instance's events of this type?"
CREATE INDEX IF NOT EXISTS idx_agent_connections_source ON agent_connections(source_instance_id, event_type, enabled);
CREATE INDEX IF NOT EXISTS idx_agent_connections_user ON agent_connections(user_id, created_at DESC);
