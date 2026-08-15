/**
 * May this trigger fire at all? (#649)
 *
 * ── The defect this exists to remove
 *
 * Cancelling an instance wrote two status columns and nothing else
 * (`routes/instances.ts:983-991`). The listing that builds the console nav hides a cancelled row
 * (`routes/instances.ts:293`), and `pags up` stops registering it — but the per-minute cron sweep
 * selected due rows straight out of `agent_triggers` with no join to `agent_instances` and no
 * status predicate, so the instance kept waking up on schedule, kept running pipelines, and kept
 * spending the owner's BYOK tokens. With the instance gone from every surface, there was no UI
 * path left to reach the trigger and turn it off.
 *
 * ── Why the predicate lives here and not inline
 *
 * Three different routes write `agent_instances.status = 'canceled'` — the owner's own cancel
 * (`routes/instances.ts:985`), an admin cancelling one instance (`routes/admin-moderation.ts:289`)
 * and an agent suspension cancelling all of its instances in a batch
 * (`routes/admin-moderation.ts:252`). A fix applied at any one of those covers only the rows that
 * writer creates, and only from the moment it ships; rows already cancelled keep firing. Gating
 * the READ covers all three writers at once, retroactively, and cannot be forgotten by a fourth.
 *
 * ── Why an allowlist, and not `status != 'canceled'`
 *
 * This gate decides whether to spend someone's money without them watching, so it fails closed. A
 * negative predicate admits every value the column has not been taught about yet — including
 * `paused`, which `lib/status-domain.ts:81` records as declared and displayed but written by no
 * route. If pause ever acquires a writer, a paused instance must not be running cron work, and
 * with an allowlist it silently already does not. `routes/public.ts:266` — the one instance-scoped
 * read that already filtered on status — makes the same choice.
 *
 * ── `subscriptions` cannot answer this question, and must not be asked
 *
 * `subscriptions` is keyed `(agent_id, user_id)`, not per instance, so it says nothing about one
 * instance. Both directions of that imprecision are live in production today:
 *
 *   • instance `880ce9d4` is `active` while its subscription reads `canceled` — cancelling a
 *     SIBLING instance of the same agent retired the row they share.
 *   • instance `26f71cd8` is `canceled` while its subscription reads `active` — 17 sibling
 *     instances of `agent_coder_repo` share that one row and a later subscribe re-activated it.
 *
 * `agent_instances.status` is the only per-instance authority. Deciding eligibility on the
 * subscription would be wrong in both directions at once.
 */

/** The only instance status under which background work may run. */
export const ACTIVE_INSTANCE_STATUS = "active";

/**
 * True when an instance in this status may have work dispatched to it.
 *
 * The JS half of the predicate. It exists so a caller that already holds the row (a route that
 * has just loaded it, a dispatcher handed a joined result) decides the same way the SQL does,
 * rather than open-coding a second comparison that can drift from it.
 */
export function isActiveInstanceStatus(status: unknown): boolean {
	return status === ACTIVE_INSTANCE_STATUS;
}

/**
 * The SQL half: restrict a dispatch read to instances that may still run work.
 *
 * Takes the alias so the two halves cannot disagree about the value while agreeing about the
 * column. Written as one exported expression for the same reason `CHARGED_SQL` is
 * (`lib/usage-payer.ts:60`): the failure mode is a NEW dispatch read written without it, and a
 * literal that appears in exactly one place is one a reviewer can grep for.
 */
export function activeInstanceSql(alias: string): string {
	return `${alias}.status = '${ACTIVE_INSTANCE_STATUS}'`;
}
