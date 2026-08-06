-- The remote tool catalog behind first-class imported MCP tools (issue #261).
--
-- WHAT THIS FIXES. An MCP-client agent had exactly two tools: `mcp_list_tools` and
-- `mcp_call_tool`. The model had to discover a server's tool names, remember them across turns,
-- and then call a stringly-typed passthrough with a free-form `args` object. Every schema the
-- server publishes — the whole reason MCP is worth speaking — was thrown away at the boundary.
-- With this, the tools a server publishes AND the owner has granted are projected into real
-- function tools with the server's own name, description and input schema.
--
-- WHY IT MUST BE PERSISTED. The catalog is read from `tools/list`, which is a network call. The
-- agent runtime builds its tool definitions on every turn, and a per-turn round trip to each
-- configured MCP server would make chat latency a function of somebody else's uptime. So the
-- catalog is cached here and refreshed by an explicit action (the connection test), which is also
-- what makes the set SHRINKABLE: a refresh replaces an endpoint's rows wholesale, so a tool the
-- server has removed stops being offered instead of lingering as a callable ghost.
--
-- WHAT IT IS NOT, AND MUST NEVER BECOME.
--
--  • It is NOT a permission. Nothing here grants anything. Reach is still `instance_mcp_consent`
--    (#262) at (instance, endpoint, remote tool), and it is still checked on the REMOTE tool
--    name at dispatch. Projection READS the grants; it cannot widen them. A row here for an
--    ungranted tool is simply never projected, and a projected call that somehow arrived would
--    still be refused by the same gate every `mcp_call_tool` passes.
--  • It is NOT a connection record. #266 stands: no id, no nickname, no cached status. The key
--    is `(user_id, endpoint, tool)` on the SAME normalized endpoint consent and credentials key
--    on, so nothing here can drift from enforcement, and `updated_at` records when we last asked
--    the server — never whether it is up.
--  • The synthetic tool name an agent sees is NOT stored and is NOT an identity. It is derived
--    at projection time and resolved back to (endpoint, tool) before anything is checked or sent.
--    Storing it would create a second name for the same thing, and the destructive-name test and
--    the grant lookup both run on the name we put on the wire — a stored alias is how those two
--    silently stop matching.
--
-- The catalog is REMOTE, ATTACKER-SHAPED DATA on its way into a model prompt: the description
-- ends up in a tool definition and the schema is handed to the model verbatim. Bounds are
-- enforced in code (lib/mcp-tool-catalog.ts) rather than trusted here — 300-char descriptions,
-- object-only schemas, a per-endpoint tool cap — because SQLite would happily store a megabyte.
CREATE TABLE IF NOT EXISTS mcp_tool_catalog (
  user_id      TEXT NOT NULL REFERENCES users(id),
  endpoint     TEXT NOT NULL,            -- normalized, e.g. 'https://builder.example.com/mcp'
  tool         TEXT NOT NULL,            -- the REMOTE name, exactly as the server published it
  description  TEXT,                     -- server-supplied, bounded; shown to the model as a claim
  input_schema TEXT,                     -- JSON object (draft-07-ish) as published, or NULL
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, endpoint, tool)
);

-- The read the projection actually does: every tool this account has cached for one endpoint.
CREATE INDEX IF NOT EXISTS idx_mcp_tool_catalog_endpoint ON mcp_tool_catalog(user_id, endpoint);
