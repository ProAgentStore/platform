-- Retire the legacy cloud-brain Job Application Assistant for NEW subscriptions and starts.
--
-- The replacement is the owner-controlled Scout → Tailor → Runner pipeline (0180–0181).
-- `draft` preserves the catalog row and every existing `agent_instances` foreign-key target,
-- while removing it from list_agents and refusing new subscriptions. Existing JOB_APPLY tasks,
-- workflow traces, board cards, résumés and apply-tip history are intentionally untouched.
--
-- The API/chat/MCP start paths return an actionable 410 separately; this migration only changes
-- catalogue discoverability. Do not delete the agent row or rewrite historical task types.

UPDATE agents
   SET visibility = 'draft',
       updated_at = datetime('now')
 WHERE slug = 'job-application-assistant';
