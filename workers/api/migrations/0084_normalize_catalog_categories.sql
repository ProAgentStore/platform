-- Normalize the two catalog categories that don't match the storefront's vocabulary (#64).
--
-- The store homepage filters with an EXACT string match (`a.category === currentCategory`,
-- store/index.html) against a hardcoded button row: chat · code · data · creative ·
-- productivity. A category that is not spelled exactly like one of those buttons is
-- unreachable by any filter — the agent only ever appears under "All".
--
-- Two published agents are wrong rather than merely uncategorized, so they are safe to fix
-- here. Everything else (developer-tools, education, social, general) is a *legitimate*
-- category the hardcoded button row simply doesn't offer; that is a storefront bug, not a
-- data bug, and deliberately NOT papered over by re-labelling good data.
--
--   1. `coding` → `code`. Same concept, two spellings. `code` is canonical: it is what the
--      store button, the console's creator-facing CATEGORIES picker
--      (store/console/src/pages/AgentDetail.tsx) and the other three coding agents
--      (coder, coder-repo, coder-lead) all use. Only `tmux-operator` says `coding`, which
--      is why it was the one coding agent missing from the "Code" filter.
--
--   2. `Sales` → `sales`. Casing outlier — every other category in the table is lowercase,
--      so it renders as an odd-one-out chip on the agent card. No filter matches it either
--      way; this is consistency only.
--
-- Safety: category only feeds (a) the storefront filter/chip and (b) the *fallback*
-- capability derivation in lib/agent-capabilities.ts, which is reached only when an agent
-- has no declared `capabilities.surfaces` array. `tmux-operator` declares
-- `surfaces:["tmux"]`, so it returns at the declared branch and its resolved capabilities
-- are unchanged by this. The fallback's category rules are `code` and `insurance`; neither
-- `Sales` nor `sales` matches either, so the Sales agents are unaffected too.
--
-- Both statements are narrow and idempotent (re-running matches nothing).

UPDATE agents
SET category = 'code',
    updated_at = datetime('now')
WHERE category = 'coding';

UPDATE agents
SET category = 'sales',
    updated_at = datetime('now')
WHERE category = 'Sales';
