/**
 * Agent-to-agent connections — the "pump" that lets one agent feed another WITHOUT sharing
 * storage (migration 0056). A connection is a single edge:
 *
 *     source instance  --(event_type)-->  target instance : action
 *
 * When the source emits a typed event (e.g. "lead.created"), we look up the enabled
 * connections for (source, event_type) and deliver each payload to the target by running a
 * trigger action (insert_record / run_pipeline / create_task / add_knowledge) via the SAME
 * handler a webhook trigger uses (lib/triggers.ts `executeTriggerAction`). So instances stay
 * isolated (the marketplace invariant), data flows as events, and each agent owns its own copy.
 *
 * Ownership: both instances must belong to the caller — you wire YOUR OWN agents only. This is
 * enforced at create time; delivery is keyed by source_instance_id (already owner-unique).
 */
import type { Env } from "../types.js";
import { executeTriggerAction, type TriggerAction } from "./triggers.js";
import { logEvent } from "./events.js";

/** Actions a connection may deliver. `sync_connector` is deliberately excluded — a connection
 *  carries data between agents, it does not run an external connector sync. */
export const CONNECTION_ACTIONS: readonly TriggerAction[] = ["insert_record", "run_pipeline", "create_task", "add_knowledge"];

export interface ConnectionRow {
	id: string;
	user_id: string;
	source_instance_id: string;
	event_type: string;
	target_instance_id: string;
	action: TriggerAction;
	config: string | null;
	enabled: number;
	created_at: string;
	updated_at: string;
}

export interface ConnectionView {
	id: string;
	sourceInstanceId: string;
	eventType: string;
	targetInstanceId: string;
	action: TriggerAction;
	config: Record<string, unknown>;
	enabled: boolean;
	createdAt: string;
}

function parseConfigJson(s: string | null): Record<string, unknown> {
	if (!s) return {};
	try {
		const v = JSON.parse(s);
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function toView(row: ConnectionRow): ConnectionView {
	return {
		id: row.id,
		sourceInstanceId: row.source_instance_id,
		eventType: row.event_type,
		targetInstanceId: row.target_instance_id,
		action: row.action,
		config: parseConfigJson(row.config),
		enabled: !!row.enabled,
		createdAt: row.created_at,
	};
}

async function ownsInstance(env: Env, instanceId: string, userId: string): Promise<boolean> {
	const row = await env.DB.prepare("SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.first<{ id: string }>();
	return !!row;
}

/** List the caller's connections, most recent first; optionally scoped to one source instance. */
export async function listConnections(env: Env, userId: string, opts: { sourceInstanceId?: string } = {}): Promise<ConnectionView[]> {
	const sql = opts.sourceInstanceId
		? "SELECT * FROM agent_connections WHERE user_id = ?1 AND source_instance_id = ?2 ORDER BY created_at DESC"
		: "SELECT * FROM agent_connections WHERE user_id = ?1 ORDER BY created_at DESC";
	const stmt = opts.sourceInstanceId ? env.DB.prepare(sql).bind(userId, opts.sourceInstanceId) : env.DB.prepare(sql).bind(userId);
	const { results } = await stmt.all<ConnectionRow>();
	return (results ?? []).map(toView);
}

export type CreateConnectionInput = {
	sourceInstanceId: string;
	eventType: string;
	targetInstanceId: string;
	action: TriggerAction;
	config?: Record<string, unknown>;
};

/** Create a connection after verifying the caller owns BOTH instances and the action is allowed.
 *  Returns `{ ok:false, error }` on a validation failure (the route maps it to 400/404). */
export async function createConnection(
	env: Env,
	userId: string,
	input: CreateConnectionInput,
): Promise<{ ok: true; connection: ConnectionView } | { ok: false; status: number; error: string }> {
	const eventType = (input.eventType || "").trim();
	if (!eventType) return { ok: false, status: 400, error: "eventType is required" };
	if (!CONNECTION_ACTIONS.includes(input.action)) return { ok: false, status: 400, error: `action must be one of ${CONNECTION_ACTIONS.join(", ")}` };
	if (input.sourceInstanceId === input.targetInstanceId) return { ok: false, status: 400, error: "source and target must be different instances" };
	if (!(await ownsInstance(env, input.sourceInstanceId, userId))) return { ok: false, status: 404, error: "source instance not found" };
	if (!(await ownsInstance(env, input.targetInstanceId, userId))) return { ok: false, status: 404, error: "target instance not found" };

	const id = crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO agent_connections (id, user_id, source_instance_id, event_type, target_instance_id, action, config, enabled, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, datetime('now'), datetime('now'))`,
	)
		.bind(id, userId, input.sourceInstanceId, eventType, input.targetInstanceId, input.action, JSON.stringify(input.config ?? {}))
		.run();
	const row = await env.DB.prepare("SELECT * FROM agent_connections WHERE id = ?1").bind(id).first<ConnectionRow>();
	return { ok: true, connection: toView(row as ConnectionRow) };
}

/** Delete one of the caller's connections. Returns whether a row was removed. */
export async function deleteConnection(env: Env, userId: string, id: string): Promise<boolean> {
	const res = await env.DB.prepare("DELETE FROM agent_connections WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
	return (res.meta?.changes ?? 0) > 0;
}

/**
 * Deliver an emitted event to every enabled connection on (sourceInstanceId, eventType).
 * Each payload runs the target's action via executeTriggerAction. Best-effort per delivery —
 * one failing target never blocks the source pipeline or the other targets; failures are
 * logged to the trace. Returns delivery counts. No-op (fast) when no connection matches.
 */
export async function deliverEvent(
	env: Env,
	sourceInstanceId: string,
	userId: string,
	eventType: string,
	payloads: unknown[],
): Promise<{ connections: number; delivered: number; failed: number }> {
	if (!payloads.length) return { connections: 0, delivered: 0, failed: 0 };
	const { results } = await env.DB.prepare(
		"SELECT * FROM agent_connections WHERE source_instance_id = ?1 AND event_type = ?2 AND enabled = 1",
	)
		.bind(sourceInstanceId, eventType)
		.all<ConnectionRow>();
	const conns = results ?? [];
	if (!conns.length) return { connections: 0, delivered: 0, failed: 0 };

	let delivered = 0;
	let failed = 0;
	for (const conn of conns) {
		const config = parseConfigJson(conn.config);
		for (const payload of payloads) {
			try {
				await executeTriggerAction(
					env,
					{ action: conn.action, name: `connection:${eventType}`, instance_id: conn.target_instance_id, user_id: conn.user_id },
					config,
					"webhook",
					payload,
				);
				delivered++;
			} catch (err) {
				failed++;
				await logEvent(env, {
					source: "connection",
					event: "connection.delivery_failed",
					level: "error",
					message: err instanceof Error ? err.message : String(err),
					userId,
					instanceId: sourceInstanceId,
					context: { connectionId: conn.id, eventType, action: conn.action, targetInstanceId: conn.target_instance_id },
				});
			}
		}
	}
	await logEvent(env, {
		source: "connection",
		event: "connection.delivered",
		message: `${eventType}: ${delivered} delivered to ${conns.length} connection(s)${failed ? `, ${failed} failed` : ""}`,
		userId,
		instanceId: sourceInstanceId,
		context: { eventType, connections: conns.length, delivered, failed },
	});
	return { connections: conns.length, delivered, failed };
}
