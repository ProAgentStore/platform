/**
 * What the `subscriptions` row means, and who is allowed to retire it (#669).
 *
 * ── The defect this exists to remove
 *
 * `subscriptions` is keyed `UNIQUE(agent_id, user_id)` (migration 0002:27) — one row per
 * (agent, subscriber), NOT one per instance. The platform has supported subscribing to the same
 * agent N times since the one-instance-per-agent 409 was dropped, and `routes/instances.ts:182`
 * upserts that single row on every subscribe. Both cancel writers then retired it on behalf of
 * ONE instance, so the row said something false about the set it covers — measured live in both
 * directions when #649 went looking:
 *
 *   • instance `880ce9d4` — active, its subscription `canceled`, because a SIBLING was cancelled.
 *   • instance `26f71cd8` — cancelled, its subscription `active`, with 18 siblings sharing it.
 *
 * ── Why the row is not made per-instance
 *
 * That was the other fork, and it costs a schema change plus a backfill to arrive somewhere the
 * codebase has already decided it does not want to be: #649 established that
 * `agent_instances.status` is the ONLY per-instance authority, and adding `subscriptions.
 * instance_id` would mint a second encoding of exactly that — the failure mode #587 is, and the
 * one `lib/status-domain.ts` was written to catch. So the row keeps its key and stops being asked
 * a question its key cannot answer: it is per (agent, user), and it is retired only when the user
 * holds no live instance of that agent at all.
 *
 * ── Why the predicate is negative here, when #649's is an allowlist
 *
 * Both fail closed; "closed" points the other way for this question. #649 gates whether to SPEND
 * someone's money unwatched, so it admits only `'active'` and a status it has not been taught
 * about runs nothing. This decides whether to RETIRE someone's standing, so the safe answer is to
 * leave it standing: a sibling in any status other than `'canceled'` — `'paused'` is declared and
 * displayed but written by no route today — keeps the subscription alive. An allowlist here would
 * retire the subscription of a user who had merely paused their last instance.
 *
 * That is also why this is not `activeInstanceSql`. Same column, same table, different question,
 * and welding them together would make a future pause writer silently cancel subscriptions.
 */

/**
 * Retire the (agent, user) subscription — but only if the instance being cancelled was the last
 * live one.
 *
 * Binds `?1` agent id, `?2` user id, `?3` the instance being cancelled. That third parameter is
 * what makes the statement independent of where it sits in a `DB.batch()`: the cancel writes
 * `agent_instances.status` first, so the row would be excluded anyway, but a statement whose
 * correctness depends on the ordering of a sibling statement is one a later edit can silently
 * break. Excluding the subject by id says the intent — "no OTHER live instance" — out loud.
 *
 * `status = 'active'` on `subscriptions` keeps the write idempotent: a row already retired is not
 * re-stamped with a new `canceled_at`.
 *
 * The reconciliation of rows written before this — migration `0131` — derives from the same rule,
 * in both directions. It cannot import this string, so it repeats it; if this predicate ever
 * changes, that migration is the other place the rule is written down.
 */
export function retireSubscriptionSql(): string {
	return `UPDATE subscriptions SET status = 'canceled', canceled_at = datetime('now')
     WHERE agent_id = ?1 AND user_id = ?2 AND status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM agent_instances si
          WHERE si.agent_id = ?1 AND si.user_id = ?2 AND si.id <> ?3 AND si.status <> 'canceled'
       )`;
}
