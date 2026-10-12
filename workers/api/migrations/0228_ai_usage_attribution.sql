-- #1040: attribute provider-token spend by objective, phase, tool use and retry — privacy-safe.
--
-- The ledger (0048) already records tokens, cache and estimated cost per call by user, agent,
-- instance, model and kind. It could not say WHICH objective a call served, which phase of it, whether
-- the call asked for tools, or whether it was a retry of a stalled call — the facts needed to find the
-- top spend drivers and to show that a saving is real. Every new column is an id, a closed label or a
-- count, never prompt or reply text:
--
--   trace_id   the run/objective trace the call belonged to (the same id agent_trace and the coding
--              timeline use); NULL when the call had none.
--   source     the prompt source label (e.g. copilot, loop, coder-brain, overseer, chat).
--   phase      the prompt phase label (e.g. decide, final, repo_agent).
--   tool_calls how many tool calls the reply requested (0 for a plain answer).
--   attempt    1 for a first call; 2+ for a controller retry after a provider stall (#907).
ALTER TABLE ai_usage ADD COLUMN trace_id TEXT;
ALTER TABLE ai_usage ADD COLUMN source TEXT;
ALTER TABLE ai_usage ADD COLUMN phase TEXT;
ALTER TABLE ai_usage ADD COLUMN tool_calls INTEGER;
ALTER TABLE ai_usage ADD COLUMN attempt INTEGER;

-- The drivers report groups an owner's window by objective.
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_trace ON ai_usage(user_id, trace_id, created_at);

-- A daily spend ALERT beside the ceilings (#1040): a push when the rolling 24h charged spend reaches
-- it, at most once a day. Unlike `charged_micros_ceiling` it never stops anything. `sent_at` is a
-- datetime the cron writes (TEXT, so it is not mistaken for a settable limit), never a setting.
ALTER TABLE account_budget_limits ADD COLUMN spend_alert_micros INTEGER;
ALTER TABLE account_budget_limits ADD COLUMN spend_alert_sent_at TEXT;
