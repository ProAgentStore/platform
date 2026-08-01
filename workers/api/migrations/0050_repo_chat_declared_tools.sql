-- Repo Chat: declare its tool allowlist as DATA (capabilities.tools) instead of
-- relying on the hardcoded `repo`-surface special-case in toolNamesFor.
--
-- This is the first agent to use the declarative tool catalog (#51 / PR #59) — the
-- "creator way" — so it doubles as the reference example a future creator copies.
-- Behavior-preserving: BASE + read-only KB is exactly what the `repo` surface already
-- resolved to; this only makes that choice explicit + data-driven. The surface stays
-- ["repo"] so the Repo tab and technical response-style are unchanged.
--
-- Idempotent: re-running re-sets the same JSON; a no-op on databases without the agent.

UPDATE agents
SET config = json_set(
  COALESCE(NULLIF(config, ''), '{}'),
  '$.capabilities.tools',
  json('["search_knowledge","list_knowledge","read_knowledge"]')
)
WHERE slug = 'repo-chat';
