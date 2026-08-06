-- Per-server, per-remote-tool consent for the outbound MCP connector (issue #262).
--
-- `instance_connector_consent` (migration 0051) grants a scope on a CONNECTOR. For every
-- other connector that names the remote system, because the connector IS the system. Outbound
-- MCP is the exception: the server is a URL supplied by config at call time, so one
-- ('mcp','write') row authorised every MCP server the instance could name and every tool on
-- each of them. A row here names the reach instead: this instance may call this tool on this
-- endpoint.
--
-- `endpoint` is the normalized form (scheme://host[:port]/path, lowercased, no trailing slash,
-- query and fragment dropped) — see lib/mcp-consent.ts normalizeMcpEndpoint. Dropping the
-- query means consent can't be dodged with a cache-buster, and keeps a credential-bearing
-- query string out of the table.
--
-- `tool` is the remote tool's name, or '*' for "every tool on this server except the
-- destructive-looking ones" (isDestructiveToolName). Enforced in the mcp_call_tool handler
-- BEFORE anything is dispatched; fail-closed (no row -> refused). The connector-level row
-- remains the outer gate and the kill switch.
CREATE TABLE IF NOT EXISTS instance_mcp_consent (
  instance_id TEXT NOT NULL REFERENCES agent_instances(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  endpoint    TEXT NOT NULL,   -- normalized, e.g. 'https://builder.example.com/mcp'
  tool        TEXT NOT NULL,   -- remote tool name, or '*'
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (instance_id, endpoint, tool)
);
CREATE INDEX IF NOT EXISTS idx_mcp_consent_user ON instance_mcp_consent(user_id, created_at DESC);
