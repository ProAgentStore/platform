-- Unified agent trace log. One append-only stream of everything an agent DID —
-- chat turns, tool calls, apply steps/handoffs/outcomes, and (bridged from
-- error_log) failures — so a single query reconstructs the complete timeline of a
-- run for debugging + improvement. Read back via GET /v1/instances/:id/trace and
-- the MCP `agent_trace` tool. Retention is opportunistic (see lib/events.ts).
CREATE TABLE IF NOT EXISTS agent_events (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,          -- ms epoch — precise ordering within a second
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  user_id     TEXT,                      -- owner (scoping)
  instance_id TEXT,                      -- the agent instance this happened on
  trace_id    TEXT,                      -- groups one run: taskId | chat turn | session id
  source      TEXT NOT NULL,             -- 'chat' | 'apply' | 'coding' | 'voice' | 'tool' | ...
  level       TEXT NOT NULL DEFAULT 'info', -- 'debug' | 'info' | 'warn' | 'error'
  event       TEXT NOT NULL,             -- 'chat.in' | 'tool.call' | 'apply.step' | 'apply.end' | 'error'
  message     TEXT,                      -- human-readable summary
  context     TEXT                       -- JSON extras
);
CREATE INDEX IF NOT EXISTS idx_agent_events_instance_ts ON agent_events(instance_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_agent_events_trace_ts ON agent_events(trace_id, ts);
CREATE INDEX IF NOT EXISTS idx_agent_events_user_ts ON agent_events(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_agent_events_created ON agent_events(created_at);
