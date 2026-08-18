/**
 * The one definition of what deleting an agent removes, and who is allowed to remove it (#646).
 *
 * ── Why this file exists
 *
 * Three routes delete an agent — `routes/agents.ts` (the owner), `routes/batch.ts` (bulk) and
 * `routes/admin-moderation.ts` (the operator) — and each hand-wrote its own cascade. They had
 * drifted to three different child lists: only `batch.ts` cleared `agent_versions`, so saving a
 * version was enough to make `DELETE /v1/agents/:id` fail on a FOREIGN KEY while
 * `POST /v1/batch/bulk-delete` on the same agent succeeded. Two routes with the same name for the
 * same act, differing by one line. `migrations/0095_agent_funnel_daily.sql` already named this
 * shape ("Agent deletion is spread across three call sites … each hand-writing its own cascade")
 * and worked around it by declining to add a foreign key at all.
 *
 * None of the three cleared `agent_instances`, `subscriptions` or `agent_triggers`, all of which
 * hold a `REFERENCES agents(id)` with no `ON DELETE` clause. D1 enforces foreign keys and
 * `DB.batch()` is one transaction, so **a creator could not delete their own agent once anyone had
 * ever subscribed to it** — the whole batch was rejected and the console showed the raw D1
 * constraint message in an `alert()`. Cancelling an instance does not remove its row, so the
 * operator's `force=true` — which only flipped instances to `'canceled'` — failed on precisely the
 * agents it exists for.
 *
 * ── Mechanism here, policy at the call site
 *
 * This module owns the MECHANISM: {@link agentDeleteStatements} returns the complete, correctly
 * ordered statement list, derived from one declared table map. Every route uses it, so the three
 * lists cannot drift apart again — and `agent-cascade.invariant.test.ts` walks the real migrated
 * schema and fails if a new table takes a foreign key onto `agents` or `agent_instances` without
 * being added here.
 *
 * The routes own the POLICY, and they legitimately differ, because they are not the same actor:
 *
 *  • **Owner / bulk** — refuse with an actionable 409 when any subscriber row belongs to SOMEBODY
 *    ELSE. An instance is a different tenant's data (see `~/dev/stores/pags/CLAUDE.md`
 *    § "Marketplace model": "Creator never sees client data"), and a creator pressing Delete on a
 *    template must not be able to destroy a subscriber's workspace as a side effect. The creator's
 *    OWN instances of their OWN agent are their own data and go with it.
 *  • **Operator** — `force=true` removes them, because that route is explicitly cross-tenant,
 *    requires the agent's slug echoed back, and writes an `admin_audit_log` row. It is the one
 *    place where destroying another tenant's rows is the documented job rather than a side effect.
 *
 * ── What this does NOT delete, stated so nobody reads its silence as coverage
 *
 * D1 rows only. An instance's Durable Object — where the subscriber's knowledge base, files and
 * collections actually live — is not touched, and no path in this Worker has ever deleted one
 * (cancelling a subscription does not either). So a forced delete orphans DO storage rather than
 * clearing it. That is unchanged by this file and deliberately out of its scope; noting it here so
 * the next reader does not assume a full erasure happened.
 */

/** What still references an agent, and how much of it belongs to somebody other than the owner. */
export interface AgentSubscribers {
	/** Every `agent_instances` row for this agent, whatever its status. */
	instances: number;
	/** …of which are still `'active'`. Reported for the audit trail; never the gate (see below). */
	activeInstances: number;
	/** Instances whose subscriber is not the agent's owner. */
	foreignInstances: number;
	subscriptions: number;
	/** Subscriptions belonging to somebody other than the owner. */
	foreignSubscriptions: number;
}

/**
 * Tables keyed by `instance_id`, in the order they must be cleared: a child before its parent.
 *
 * `agent_trigger_events` and `agent_trigger_sync_state` come before `agent_triggers` because they
 * reference it; `coding_timeline` before `coding_sessions` before `coding_repos` for the same
 * reason. `instance_connector_grants` and `agent_trigger_sync_state.trigger_id` already declare
 * `ON DELETE CASCADE` and would go on their own — they are listed anyway so this map is the whole
 * answer rather than half of it plus a schema detail the reader has to know.
 */
export const INSTANCE_CHILD_TABLES = [
	"coding_timeline",
	"coding_sessions",
	"coding_repos",
	"agent_trigger_events",
	"agent_trigger_sync_state",
	"agent_triggers",
	"instance_runtimes",
	"instance_runtime_tasks",
	"instance_runtime_task_events",
	"instance_runtime_nodes",
	"instance_connector_grants",
	"instance_connector_consent",
	"instance_mcp_consent",
	"mcp_input_requests",
] as const;

/**
 * Tables keyed by `agent_id`, cleared after the instance subtree and before `agents` itself.
 *
 * `agent_funnel_daily` is the odd one out: migration 0095 deliberately declares NO foreign key
 * ("a view counter must never be the reason a delete fails"), so nothing would drop it
 * automatically and it is cascaded by hand here — which is exactly what 0095 says these call sites
 * do. The rest each hold a real `REFERENCES agents(id)`.
 */
export const AGENT_CHILD_TABLES = [
	"agent_instances",
	"subscriptions",
	"agent_versions",
	"agent_executions",
	"usage",
	"agent_funnel_daily",
] as const;

/** Every table an agent delete touches, for the invariant test to compare against the schema. */
export const AGENT_CASCADE_TABLES: readonly string[] = [...INSTANCE_CHILD_TABLES, ...AGENT_CHILD_TABLES];

/**
 * The instance rows a delete would take with it, split by whose they are.
 *
 * ONE statement, because the policy decision needs all of these at once and three round trips to
 * answer one question is three chances for them to disagree. `foreignInstances` counts rows whose
 * subscriber is not `ownerId` — that, not `status`, is the number that decides whether a delete is
 * allowed to proceed: a `'canceled'` instance still holds the foreign key, so counting only the
 * active ones is how the operator's `force` path came to fail on a 500 instead of refusing.
 */
export async function countAgentSubscribers(
	db: D1Database,
	agentId: string,
	ownerId: string,
): Promise<AgentSubscribers> {
	const row = await db
		.prepare(
			`SELECT
			   (SELECT COUNT(*) FROM agent_instances WHERE agent_id = ?1) AS instances,
			   (SELECT COUNT(*) FROM agent_instances WHERE agent_id = ?1 AND status = 'active') AS active_instances,
			   (SELECT COUNT(*) FROM agent_instances WHERE agent_id = ?1 AND user_id <> ?2) AS foreign_instances,
			   (SELECT COUNT(*) FROM subscriptions WHERE agent_id = ?1) AS subscriptions,
			   (SELECT COUNT(*) FROM subscriptions WHERE agent_id = ?1 AND user_id <> ?2) AS foreign_subscriptions`,
		)
		.bind(agentId, ownerId)
		.first<{
			instances: number;
			active_instances: number;
			foreign_instances: number;
			subscriptions: number;
			foreign_subscriptions: number;
		}>();
	return {
		instances: row?.instances ?? 0,
		activeInstances: row?.active_instances ?? 0,
		foreignInstances: row?.foreign_instances ?? 0,
		subscriptions: row?.subscriptions ?? 0,
		foreignSubscriptions: row?.foreign_subscriptions ?? 0,
	};
}

/** Does anything reference this agent that a delete would have to remove first? */
export function hasSubscriberRows(counts: AgentSubscribers): boolean {
	return counts.instances > 0 || counts.subscriptions > 0;
}

/** Rows belonging to a tenant who is not the owner — the ones a creator may never destroy. */
export function hasForeignSubscriberRows(counts: AgentSubscribers): boolean {
	return counts.foreignInstances > 0 || counts.foreignSubscriptions > 0;
}

/** The 409 an owner or bulk delete answers with, saying what is in the way and what to do. */
export function foreignSubscriberRefusal(counts: AgentSubscribers): string {
	const parts: string[] = [];
	if (counts.foreignInstances > 0) parts.push(`${counts.foreignInstances} instance(s)`);
	if (counts.foreignSubscriptions > 0) parts.push(`${counts.foreignSubscriptions} subscription(s)`);
	return (
		`Other users hold ${parts.join(" and ")} of this agent; deleting it would destroy their data. ` +
		"Set it to draft or unlisted to take it off the store, or ask an operator to force-delete it."
	);
}

/**
 * Every statement a delete issues, in order, ending with the `agents` row itself.
 *
 * Pass them to `DB.batch()`, which is one transaction: either the whole cascade lands or none of
 * it does, so a failure can never leave an agent half-deleted.
 *
 * The instance subtree is 14 statements and is emitted only when the caller has established there
 * are subscriber rows to clear ({@link hasSubscriberRows}); a bulk delete of clean agents keeps
 * the batch the size it was. When it IS emitted, each statement scopes itself with
 * `instance_id IN (SELECT id FROM agent_instances WHERE agent_id = ?1)` rather than a list of ids
 * read beforehand — one fewer round trip, and no window in which a subscribe lands between the
 * read and the write.
 */
export function agentDeleteStatements(
	db: D1Database,
	agentId: string,
	opts: { cascadeSubscribers: boolean },
): D1PreparedStatement[] {
	const stmts: D1PreparedStatement[] = [];
	if (opts.cascadeSubscribers) {
		for (const table of INSTANCE_CHILD_TABLES) {
			stmts.push(
				db
					.prepare(
						`DELETE FROM ${table} WHERE instance_id IN (SELECT id FROM agent_instances WHERE agent_id = ?1)`,
					)
					.bind(agentId),
			);
		}
	}
	for (const table of AGENT_CHILD_TABLES) {
		stmts.push(db.prepare(`DELETE FROM ${table} WHERE agent_id = ?1`).bind(agentId));
	}
	stmts.push(db.prepare("DELETE FROM agents WHERE id = ?1").bind(agentId));
	return stmts;
}
