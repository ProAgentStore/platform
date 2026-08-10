-- Per-account and platform-wide budget ceiling overrides (issue #474, epic #478).
--
-- The two account backstop constants in delegation-budget-store.ts
-- (DAILY_CEILING_MICROS = $50, DAILY_TOKEN_CEILING = 250M) were hardcoded. Every
-- change required a deploy. A new account doing intensive work hits the same wall as a
-- test account doing nothing. There was no operator lever to raise a ceiling for a
-- known-good user without redeploying for everyone.
--
-- This table holds overrides that slot between the hard-coded constants and the actual
-- enforcement in reserve(). Resolution order (highest wins):
--
--   1. Per-account row (user_id = that account's uid)
--   2. Platform-default row (user_id = '__platform__')
--   3. Env var (ACCOUNT_DAILY_CHARGED_MICROS_CEILING / ACCOUNT_DAILY_TOKEN_CEILING)
--   4. The current hard constant (never changes, always the floor)
--
-- NULL in any column means "inherit from the next level down", so a per-account row
-- that only overrides the token ceiling leaves the money ceiling resolved from the
-- platform default (or env, or constant).
--
-- per_tree_cost_micros is the ceiling passed to sanitizeLimits in openBudget — what
-- a single delegation tree may spend (currently derived from p95 history, bounded by
-- DEFAULT_LIMITS.costMicros = $5). An operator can raise this for power users without
-- changing the account-wide daily backstop.
--
-- delegations and max_depth follow the same pattern for the tree limits.

CREATE TABLE IF NOT EXISTS account_budget_limits (
  user_id                    TEXT    PRIMARY KEY,
  token_ceiling              INTEGER,          -- NULL = inherit
  charged_micros_ceiling     INTEGER,          -- NULL = inherit
  per_tree_cost_micros       INTEGER,          -- NULL = inherit
  delegations                INTEGER,          -- NULL = inherit
  max_depth                  INTEGER,          -- NULL = inherit
  updated_at                 TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Platform-wide default row. All columns NULL until an operator overrides one.
-- The resolver falls through to the env var / hard constant for any NULL field.
INSERT INTO account_budget_limits (user_id, updated_at)
VALUES ('__platform__', datetime('now'))
ON CONFLICT(user_id) DO NOTHING;
