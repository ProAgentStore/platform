-- Agent capability registry: declare each agent's surfaces/runtime/workflow in
-- config.capabilities so the platform renders behaviour from a declared registry
-- instead of branching on agent slug/category. lib/agent-capabilities.ts reads
-- this; the slug-based derivation there is now just a safety net for any agent
-- that hasn't declared yet.
--
-- Idempotent: re-running re-sets the same JSON.

UPDATE agents
SET config = json_set(COALESCE(NULLIF(config, ''), '{}'), '$.capabilities',
  json('{"surfaces":["coding"],"runtime":"coding","workflow":"CODING_SESSION"}'))
WHERE slug = 'coder';

UPDATE agents
SET config = json_set(COALESCE(NULLIF(config, ''), '{}'), '$.capabilities',
  json('{"surfaces":["apply"],"runtime":"browser","workflow":"JOB_APPLY"}'))
WHERE slug = 'job-application-assistant';
