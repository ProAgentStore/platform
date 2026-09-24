-- #841: offer a separate subscription-backed path without replacing the working
-- cloud pipeline. The local path is opt-in (`site-builder-local`) and draft-only.
-- A subscriber must have `pags up` connected before it can start.
UPDATE agents
SET config = json_set(
      json_set(json_set(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.capabilities.runtime', 'coding'), '$.capabilities.tools', json('["http_request","web_search","mcp_call_tool","start_website_builder"]')),
      '$.pipelines.site-builder-local',
      json('{"name":"site-builder-local","params":{"lead":{"type":"object","description":"Verified lead record passed from Lead Finder."},"mcp_url":{"type":"string","description":"FWS MCP endpoint already connected to this PAGS instance."},"engine":{"type":"string","description":"Local subscription CLI: claude or codex."},"max_refinements":{"type":"number","description":"Bounded visual/quality refinement passes (0-2)."}},"steps":[{"tool":"start_website_builder","bind":"worker","inputs":{"lead":{"$param":"lead"},"mcp_url":{"$param":"mcp_url"},"engine":{"$param":"engine"},"max_refinements":{"$param":"max_refinements"}}}]}')
    ), updated_at = datetime('now')
WHERE slug = 'site-builder';

-- Existing copies inherit the new opt-in pipeline and runtime requirement. We do
-- not overwrite `site-builder`: subscribers can test the local subscription worker
-- alongside the established cloud draft flow, then wire lead.created deliberately.
UPDATE agent_instances
SET config = json_set(
      CASE WHEN json_valid(config) THEN config ELSE '{}' END,
      '$.pipelines.site-builder-local',
      json((SELECT json_extract(a.config, '$.pipelines.site-builder-local') FROM agents a WHERE a.slug = 'site-builder'))
    ), updated_at = datetime('now')
WHERE agent_id IN (SELECT id FROM agents WHERE slug = 'site-builder');
