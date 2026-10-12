-- #1048: the lead-owning Gmail Scout declares a local browser, so browser verification (#1030) can run.
--
-- #1030 verifies a Gmail lead the server could not check in "the Scout's own browser": a local browser
-- run on the owner's machine. Turning that on per instance (#1031) is refused unless the agent DECLARES
-- `runtime: "local_browser"` — and both Scout templates declare `runtime: null` (0196 seeded it so;
-- 0197 reset the legacy row, which had declared local_browser, to null). So every lead #1030 parks as
-- awaiting_browser_verification on a live Scout could never be checked.
--
-- This declares the capability on BOTH templates, the one place `capabilitiesForInstance` reads it.
-- It turns nothing on: browser verification stays OFF per instance until the owner enables it and a
-- machine is pinned, and every new domain still pauses for the owner's consent.
--
--   - research only, on the owner's own Codex/Claude subscription (subscriptionOnly);
--   - only indeed.com and its country sites (xx.indeed.com) — the provider #1024 resolves; a posting
--     on any other host is refused by the dispatcher with the reason, never opened;
--   - small limits: a verification opens one posting.
-- Tools are unchanged — the two read-only Gmail tools, nothing else.
--
-- Additive: to undo, set `$.capabilities.runtime` back to null and remove `$.capabilities.localBrowser`.
UPDATE agents
   SET config = json_set(
         CASE WHEN json_valid(COALESCE(NULLIF(config, ''), '{}'))
              THEN COALESCE(NULLIF(config, ''), '{}')
              ELSE '{}'
         END,
         '$.capabilities.runtime', 'local_browser',
         '$.capabilities.localBrowser', json('{"engines":["claude","codex"],"mode":"research_only","subscriptionOnly":true,"limits":{"maxMinutes":10,"maxPages":10,"maxActions":100,"maxConcurrent":1},"allowDomains":["indeed.com"]}')
       ),
       updated_at = datetime('now')
 WHERE slug IN ('gmail-job-search-scout', 'job-search-scout');
