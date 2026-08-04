-- Spend bound for one delegation tree (#184).
--
-- Nothing in the platform currently enforces a spend cap. `ai_usage` (0048) records cost_micros
-- faithfully, but it is a LEDGER, not a control — it says what a runaway cost, after it cost you.
-- The only limits in the codebase are req/min rate limits, which bound request frequency.
--
-- That was survivable while hierarchy was two levels written by a human. Once supervision is
-- configurable (#183) it is not: fan-out 5 at 3 levels is 125 leaf runs from one delegation, and
-- a config typo stops being a bug and becomes a billing incident.
--
-- One row per TREE, not per instance and not per hop. A budget copied down each path would give
-- five siblings the full allowance each, making the tree total allowance × fanout^depth —
-- unbounded in exactly the quantity being bounded. So: one shared pool at the root, drawn
-- atomically by every descendant.
--
-- `cost_micros_reserved` is what makes concurrent siblings safe. Cost is known only AFTER a run,
-- so an optimistic "is there budget left?" check lets N branches all pass at once and overshoot
-- by N × run_cost (classic overbooking). Work reserves a bounded maximum up front, settles the
-- actual on completion, and gets the difference back.

CREATE TABLE IF NOT EXISTS delegation_budgets (
  id                    TEXT PRIMARY KEY,       -- the delegation tree this pool belongs to
  user_id               TEXT NOT NULL,
  root_instance_id      TEXT NOT NULL,          -- top of the tree; owns the spend and the trace

  cost_micros_limit     INTEGER NOT NULL,
  cost_micros_reserved  INTEGER NOT NULL DEFAULT 0,   -- held for in-flight work
  cost_micros_spent     INTEGER NOT NULL DEFAULT 0,   -- settled actuals

  delegations_limit     INTEGER NOT NULL,       -- depth alone bounds nothing: a supervisor can
  delegations_used      INTEGER NOT NULL DEFAULT 0,  -- re-delegate forever at constant depth
  max_depth             INTEGER NOT NULL,

  -- 'exhausted' is a distinct outcome from 'failed' on purpose: a human must be able to tell a
  -- runaway that was stopped from a subordinate that broke, and resume the former after raising
  -- the limit. Exhaustion must never destroy work already paid for.
  status                TEXT NOT NULL DEFAULT 'open',   -- open | exhausted | closed
  exhausted_reason      TEXT,                            -- cost_exhausted | delegations_exhausted | too_deep
  exhausted_at_depth    INTEGER,

  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- "What is running / what stopped for me" — the owner's view, newest first.
CREATE INDEX IF NOT EXISTS idx_delegation_budgets_user
  ON delegation_budgets(user_id, created_at DESC);

-- Open pools for a root instance: the admission read on every delegation.
CREATE INDEX IF NOT EXISTS idx_delegation_budgets_root
  ON delegation_budgets(root_instance_id, status);
