-- #669 — bring the `subscriptions` rows already in the database back in line with what they mean.
--
-- `subscriptions` is keyed UNIQUE(agent_id, user_id) (migration 0002:27): one row per
-- (agent, subscriber), shared by every instance of that agent the user holds. Both cancel writers
-- retired it on behalf of ONE instance, so the row has been wrong — in BOTH directions — since
-- multi-instance shipped. Measured in production while fixing #649:
--
--   • instance 880ce9d4 — active, subscription 'canceled': a SIBLING's cancel retired the row.
--   • instance 26f71cd8 — cancelled, subscription 'active': 18 siblings share that one row.
--
-- The code fix (`lib/subscription-standing.ts`) stops NEW divergence: a cancel now retires the row
-- only when it takes the user's last live instance of that agent. It does nothing for rows already
-- written, and the first case above is one no future write will correct — the instance is active,
-- so nothing will ever cancel it again, and the subscribe upsert only fires on a NEW subscribe.
--
-- ── The rule, applied in both directions
--
-- A subscription is 'active' if and only if the user holds at least one non-cancelled instance of
-- that agent. `<> 'canceled'` and not `= 'active'` deliberately, matching the code: this decides
-- whether to RETIRE someone's standing, so the conservative answer is to leave it standing, and a
-- sibling in a status nobody has taught this about ('paused' is declared in 0002:7 and written by
-- no route) must not cause a cancellation. #649's dispatch gate is an allowlist for the mirror
-- reason — it decides whether to SPEND, where fail-closed points the other way.
--
-- ── Why this is safe to run
--
-- Nothing reads `subscriptions.status`. Enumerated for AC3: seven statements touch this table in
-- the whole repo — one DDL, four writes (the subscribe upsert, the two cancels, and the
-- agent-delete cascade), and exactly two reads, both `COUNT(*)` in `countAgentSubscribers`
-- (`lib/agent-cascade.ts:130-131`), neither of which projects or predicates on `status`. So the
-- column is write-only today and this migration changes no decision the platform currently makes;
-- it makes the record true before billing — which is deferred, not cancelled — starts reading it.
--
-- Idempotent: after the first run every row already satisfies the rule, so both statements match
-- nothing. Neither can create a row or destroy one; `agent_instances` is not touched at all.

-- Direction 1: a live subscription wrongly retired by a sibling's cancel. This is 880ce9d4's row.
-- `canceled_at` is cleared with it, because a row that is active while carrying the timestamp of
-- its own cancellation is the same kind of half-true record this migration exists to remove.
UPDATE subscriptions
   SET status = 'active', canceled_at = NULL
 WHERE status = 'canceled'
   AND EXISTS (
     SELECT 1 FROM agent_instances i
      WHERE i.agent_id = subscriptions.agent_id AND i.user_id = subscriptions.user_id
        AND i.status <> 'canceled'
   );

-- Direction 2: a subscription still standing after the user's last instance of that agent was
-- cancelled — the case the old per-instance write happened to get right only by accident, and got
-- wrong whenever a later subscribe re-activated the shared row. `COALESCE` keeps the original
-- cancellation timestamp when one is already recorded rather than overwriting history with today.
UPDATE subscriptions
   SET status = 'canceled', canceled_at = COALESCE(canceled_at, datetime('now'))
 WHERE status = 'active'
   AND NOT EXISTS (
     SELECT 1 FROM agent_instances i
      WHERE i.agent_id = subscriptions.agent_id AND i.user_id = subscriptions.user_id
        AND i.status <> 'canceled'
   );
