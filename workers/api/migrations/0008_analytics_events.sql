-- Track page views and trial starts for analytics funnel
-- Funnel: view agent → try agent → subscribe
-- Events: 'view', 'trial_start', 'subscribe', 'chat', 'instance_chat'
-- The 'subscribe' and chat events already exist in usage table.
-- This adds lightweight view/trial tracking via the public routes.

-- No new tables needed — usage table already covers this.
-- Just documenting the event types for the funnel:
--   view          = GET /v1/public/agents/:id (detail page load)
--   trial_start   = first POST /v1/public/agents/:id/try per session
--   subscribe     = POST /v1/instances/:agentId/subscribe
--   chat          = POST /v1/agents/:id/chat
--   instance_chat = POST /v1/instances/:id/chat

-- Add index for funnel queries
CREATE INDEX IF NOT EXISTS idx_usage_event ON usage(event, agent_id, created_at);
