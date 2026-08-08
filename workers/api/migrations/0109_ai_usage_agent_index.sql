-- Index the AI ledger by agent (#451).
--
-- `ai_usage` (0048) was built for the Usage page, which always asks "what did THIS USER spend,
-- over this window" — so it carries `(user_id, created_at)`, `(instance_id, created_at)` and
-- `(user_id, payer, created_at)` (0092), and no way to ask about an agent at all.
--
-- #451 gives it a second reader with a different question. `GET /v1/agents/:id/analytics` and
-- `/:id/ops` reported their execution counters off `agent_executions`, a table with exactly one
-- writer (`routes/run.ts`, the legacy direct-inference route) that held ZERO rows in production on
-- 2026-08-08. Both now count the ledger, which held 3,628 rows for the same account — and an
-- agent-scoped `COUNT(*)` over an unindexed column is a full table scan of a table that grows once
-- per model call, forever. The alternative was to scope the count by user as well, which the index
-- exists to avoid: the calls being counted are the SUBSCRIBERS', not the creator's, so narrowing
-- to the caller would have traded a scan for a wrong answer.
--
-- `created_at` is in the key because the same predicate feeds the recent-activity lists, which
-- order by it and take the top 10 (analytics) / 5 (ops) — the index then serves the ordering
-- instead of the query sorting the whole matched set.
--
-- The second arm of that predicate — `instance_id IN (SELECT id FROM agent_instances WHERE
-- agent_id = ?1)`, which recovers the 2,091 rows that carry only an instance — is already served
-- by `idx_instances_agent` (0002) and `idx_ai_usage_instance` (0048). Nothing new is needed there.

CREATE INDEX IF NOT EXISTS idx_ai_usage_agent_time
  ON ai_usage(agent_id, created_at);
