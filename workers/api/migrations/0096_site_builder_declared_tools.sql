-- Site Builder: declare the connector tools its two pipelines actually dispatch (#381).
--
-- `capabilities.tools` is now enforced on pipeline steps, so a pipeline can only run the tools its
-- agent declares. 0057 seeded this agent with `capabilities: {surfaces:[], runtime:null,
-- workflow:null}` and no `tools` at all — which was harmless while the gate did not exist, and is
-- the difference between working and refused now: `site-builder` dispatches `http_request`,
-- `web_search` and `mcp_call_tool`, and `site-deploy` dispatches `mcp_call_tool`. Without this the
-- gate would land on the one agent whose whole behaviour IS its pipelines.
--
-- Exactly those three, and nothing else. The pipelines' other steps (`slice`, `flatten`, `map`,
-- `extract_contacts`, `ai_generate`, `parse_json`, `dedupe_upsert`, `create_ticket`) carry no
-- connector, so they are not in TOOL_CATALOG, `capabilities.tools` cannot name them, and the gate
-- exempts them — see lib/tool-refusal.ts.
--
-- It is a NARROWING as well as a fix, and deliberately so. Declaring a `tools` array makes it
-- authoritative, so this agent's CHAT drops from the permissive default (the whole storage/KB/files
-- set every undeclared agent gets) to BASE plus these three. For a cloud-only agent with
-- `surfaces: []`, whose work is done by two declarative pipelines, that is what it should have said
-- in the first place — the permissive default was never a decision anyone made about this agent.
--
-- A new migration rather than an edit to 0057: that one has already run in production, and editing
-- an applied migration changes nothing there while a fresh database gets the new text (see
-- scripts/check-migrations.mjs). Same technique 0050 used to declare Repo Chat's tools.
--
-- Idempotent: re-running re-sets the same JSON; a no-op on databases without the agent.

UPDATE agents
SET config = json_set(
      COALESCE(NULLIF(config, ''), '{}'),
      '$.capabilities.tools',
      json('["http_request","web_search","mcp_call_tool"]')
    ),
    updated_at = datetime('now')
WHERE slug = 'site-builder';
