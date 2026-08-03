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
import { matchesWhere } from "./steps.js";
import {
	dueDeliveries,
	enqueueDelivery,
	markAttemptFailed,
	markDelivered,
	parseJsonColumn,
	MAX_ATTEMPTS,
} from "./connection-deliveries.js";

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

/** Ops the routing predicate accepts — the `filter` step's vocabulary, kept identical. */
const FILTER_OPS = new Set(["eq", "ne", "exists", "missing", "truthy", "falsy", "in", "contains", "gt", "gte", "lt", "lte"]);

/**
 * Validate a connection's routing predicate at CREATE time. A filter that silently never
 * matches is worse than no filter — the chain just stops, with the connection looking healthy
 * — so a malformed one is rejected up front rather than discovered by absence months later.
 * Returns an error string, or null when valid (including when absent).
 */
export function validateConnectionFilter(raw: unknown): string | null {
	if (raw === undefined || raw === null) return null;
	const clauses = Array.isArray(raw)
		? raw
		: typeof raw === "object"
			? (raw as Record<string, unknown>).where
			: undefined;
	if (clauses === undefined) return "filter must be a clause array, or {where:[…], any?:bool}";
	if (!Array.isArray(clauses)) return "filter.where must be an array of {field, op, value} clauses";
	for (const [i, clause] of clauses.entries()) {
		if (!clause || typeof clause !== "object" || Array.isArray(clause)) return `filter clause ${i} must be an object`;
		const c = clause as Record<string, unknown>;
		if (typeof c.field !== "string" || !c.field.trim()) return `filter clause ${i} needs a "field"`;
		if (typeof c.op !== "string" || !FILTER_OPS.has(c.op)) return `filter clause ${i}: op must be one of ${[...FILTER_OPS].join(", ")}`;
		if (c.op === "in" && !Array.isArray(c.value)) return `filter clause ${i}: "in" needs an array value`;
	}
	return null;
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
	const filterError = validateConnectionFilter(input.config?.filter);
	if (filterError) return { ok: false, status: 400, error: filterError };
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
 *
 * Delivery is AT-LEAST-ONCE (migration 0058). Each payload is written to the outbox FIRST,
 * then attempted; a failure leaves a persisted row for the cron to retry with backoff, and a
 * row that exhausts its attempts becomes a visible dead letter. Previously this ran purely
 * inline and best-effort, so any transient failure in the target — the model rate-limiting,
 * a dependency down — dropped the event permanently and silently, which in a chain means a
 * lead falls out partway with nothing recording it.
 *
 * Two filters apply before anything is enqueued:
 *   • `config.filter` — routing predicate, the same {field,op,value} vocabulary the `filter`
 *     step uses ("only Sydney leads rated 4+"). A connection without one takes everything.
 *   • the unique idempotency key — a duplicate emission within one run collapses, so the
 *     consumer's irreversible work can't happen twice.
 *
 * `traceId` (the emitting run) is carried onto every delivery and into the target's run, so
 * the whole chain reads as one story in the trace instead of N disconnected runs.
 *
 * Still non-blocking for the emitter: a failing target never fails the source pipeline.
 */
export async function deliverEvent(
	env: Env,
	sourceInstanceId: string,
	userId: string,
	eventType: string,
	payloads: unknown[],
	opts: { traceId?: string | null } = {},
): Promise<{ connections: number; delivered: number; failed: number; queued: number; filtered: number; duplicate: number }> {
	const empty = { connections: 0, delivered: 0, failed: 0, queued: 0, filtered: 0, duplicate: 0 };
	if (!payloads.length) return empty;
	const { results } = await env.DB.prepare(
		"SELECT * FROM agent_connections WHERE source_instance_id = ?1 AND event_type = ?2 AND enabled = 1",
	)
		.bind(sourceInstanceId, eventType)
		.all<ConnectionRow>();
	const conns = results ?? [];
	if (!conns.length) return empty;

	let delivered = 0;
	let failed = 0;
	let queued = 0;
	let filtered = 0;
	let duplicate = 0;

	for (const conn of conns) {
		const config = parseConfigJson(conn.config);
		for (const payload of payloads) {
			// Routing predicate — a connection may take only the events it cares about.
			if (!matchesConnectionFilter(config, payload)) {
				filtered++;
				continue;
			}
			const deliveryId = await enqueueDelivery(env, {
				connectionId: conn.id,
				userId: conn.user_id,
				sourceInstanceId,
				targetInstanceId: conn.target_instance_id,
				eventType,
				action: conn.action,
				payload,
				config,
				traceId: opts.traceId ?? null,
			});
			if (!deliveryId) {
				// The idempotency key collided: this exact emission is already recorded.
				duplicate++;
				continue;
			}
			queued++;
			const outcome = await attemptDelivery(env, {
				deliveryId,
				attempts: 0,
				connectionId: conn.id,
				userId: conn.user_id,
				targetInstanceId: conn.target_instance_id,
				eventType,
				action: conn.action,
				config,
				payload,
				traceId: opts.traceId ?? null,
				sourceInstanceId,
			});
			if (outcome === "delivered") delivered++;
			else failed++;
		}
	}
	await logEvent(env, {
		source: "connection",
		event: "connection.delivered",
		message: `${eventType}: ${delivered}/${queued} delivered to ${conns.length} connection(s)${failed ? `, ${failed} queued for retry` : ""}${filtered ? `, ${filtered} filtered out` : ""}${duplicate ? `, ${duplicate} duplicate` : ""}`,
		userId,
		instanceId: sourceInstanceId,
		traceId: opts.traceId ?? undefined,
		context: { eventType, connections: conns.length, delivered, failed, filtered, duplicate },
	});
	return { connections: conns.length, delivered, failed, queued, filtered, duplicate };
}

/**
 * Apply a connection's routing predicate to one payload. `config.filter` is either a bare
 * clause array or `{where, any}` — the same shape the `filter` step takes, deliberately, so
 * there is one predicate language in the system rather than a second one for routing.
 */
export function matchesConnectionFilter(config: Record<string, unknown>, payload: unknown): boolean {
	const raw = config.filter;
	if (!raw) return true;
	if (Array.isArray(raw)) return matchesWhere(payload, raw, false);
	if (typeof raw === "object") {
		const f = raw as Record<string, unknown>;
		return matchesWhere(payload, f.where, f.any === true);
	}
	return true;
}

interface AttemptInput {
	deliveryId: string;
	attempts: number;
	connectionId: string;
	userId: string;
	sourceInstanceId: string;
	targetInstanceId: string;
	eventType: string;
	action: TriggerAction | string;
	config: Record<string, unknown>;
	payload: unknown;
	traceId: string | null;
}

/**
 * Run one delivery's action and record the outcome on its outbox row. Never throws — the
 * emitter must not fail because a consumer did, and the sweep must not stop on one bad row.
 */
export async function attemptDelivery(env: Env, input: AttemptInput): Promise<"delivered" | "retrying" | "dead"> {
	try {
		await executeTriggerAction(
			env,
			{ action: input.action as TriggerAction, name: `connection:${input.eventType}`, instance_id: input.targetInstanceId, user_id: input.userId },
			// The emitting run's id rides along so the target's run joins the same trace.
			{ ...input.config, traceId: input.traceId ?? undefined },
			"webhook",
			input.payload,
		);
		await markDelivered(env, input.deliveryId);
		return "delivered";
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const outcome = await markAttemptFailed(env, input.deliveryId, input.attempts, message);
		await logEvent(env, {
			source: "connection",
			event: outcome === "dead" ? "connection.delivery_dead" : "connection.delivery_retry",
			level: "error",
			message: outcome === "dead" ? `gave up after ${MAX_ATTEMPTS} attempts: ${message}` : message,
			userId: input.userId,
			instanceId: input.sourceInstanceId,
			traceId: input.traceId ?? undefined,
			context: {
				deliveryId: input.deliveryId,
				connectionId: input.connectionId,
				eventType: input.eventType,
				action: input.action,
				targetInstanceId: input.targetInstanceId,
				attempts: input.attempts + 1,
			},
		});
		return outcome;
	}
}

/**
 * Retry every delivery whose next attempt is due. Called from the per-minute cron alongside
 * runDueTriggers. This is what turns a transient consumer failure into a delay instead of a
 * silently dropped lead.
 */
export async function runDueDeliveries(env: Env, now = new Date(), limit = 25): Promise<{ checked: number; delivered: number; retrying: number; dead: number }> {
	const due = await dueDeliveries(env, now, limit);
	let delivered = 0;
	let retrying = 0;
	let dead = 0;
	for (const row of due) {
		let payload: unknown = null;
		try {
			payload = JSON.parse(row.payload);
		} catch {
			/* a payload we can't parse is delivered as null rather than wedging the sweep */
		}
		const outcome = await attemptDelivery(env, {
			deliveryId: row.id,
			attempts: row.attempts,
			connectionId: row.connection_id,
			userId: row.user_id,
			sourceInstanceId: row.source_instance_id,
			targetInstanceId: row.target_instance_id,
			eventType: row.event_type,
			action: row.action,
			config: parseJsonColumn(row.config),
			payload,
			traceId: row.trace_id,
		});
		if (outcome === "delivered") delivered++;
		else if (outcome === "dead") dead++;
		else retrying++;
	}
	return { checked: due.length, delivered, retrying, dead };
}
