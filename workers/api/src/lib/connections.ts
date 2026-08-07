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
	claimDelivery,
	dueDeliveries,
	enqueueDelivery,
	markAttemptFailed,
	markDelivered,
	parseJsonColumn,
	MAX_ATTEMPTS,
	type DeliveryClaim,
} from "./connection-deliveries.js";
import { classifyDeliveryFailure, connectorsUsedByPipeline, pipelineWiringWarnings, reconnectMessage } from "./connectors/unattended.js";
import { getConnector } from "./connectors/registry.js";
import { getRegistryTool } from "./tool-registry.js";
import { loadPipeline, pipelineInventory, type PipelineInventory } from "./pipeline.js";
import { connectionPipelineWarning } from "./connection-pipeline.js";
import { HttpError } from "./auth.js";

/** The HTTP status an error carries, when it carries one — `HttpError` is what every connector
 *  auth path throws, and its status is a far better signal than matching its message. */
function statusOf(err: unknown): number | undefined {
	if (err instanceof HttpError) return err.status;
	const s = (err as { status?: unknown } | null)?.status;
	return typeof s === "number" ? s : undefined;
}

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
	/**
	 * What is wrong with this edge as it stands, in the same words the create path would have
	 * used (#363). Surfaced rather than fixed: rows written before the create-time check existed
	 * may already name a pipeline the target does not have, and a connection the user wrote is
	 * theirs to delete — the same choice #358 made for impossible triggers. Empty when fine.
	 */
	warnings: string[];
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

function toView(row: ConnectionRow, warnings: string[] = []): ConnectionView {
	return {
		id: row.id,
		sourceInstanceId: row.source_instance_id,
		eventType: row.event_type,
		targetInstanceId: row.target_instance_id,
		action: row.action,
		config: parseConfigJson(row.config),
		enabled: !!row.enabled,
		createdAt: row.created_at,
		warnings,
	};
}

async function ownsInstance(env: Env, instanceId: string, userId: string): Promise<boolean> {
	const row = await env.DB.prepare("SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.first<{ id: string }>();
	return !!row;
}

/** What a target instance is CALLED and what pipelines it has — the two facts a `run_pipeline`
 *  edge is judged against. `null` inventory means the read failed; see `pipelineNamesFor`. */
interface TargetFacts {
	label: string;
	inventory: PipelineInventory | null;
}

/** Read the pipeline facts for a set of target instances in ONE query, so annotating a listing
 *  costs a single round trip rather than one per row. Owner-scoped, like every other read here. */
async function targetFactsFor(env: Env, userId: string, instanceIds: readonly string[]): Promise<Map<string, TargetFacts>> {
	const out = new Map<string, TargetFacts>();
	const ids = [...new Set(instanceIds)].filter(Boolean);
	if (!ids.length) return out;
	const placeholders = ids.map((_, i) => `?${i + 2}`).join(", ");
	const { results } = await env.DB.prepare(
		`SELECT ai.id AS id, ai.config AS config, a.name AS agent_name
       FROM agent_instances ai JOIN agents a ON a.id = ai.agent_id
      WHERE ai.user_id = ?1 AND ai.id IN (${placeholders})`,
	)
		.bind(userId, ...ids)
		.all<{ id: string; config: string | null; agent_name: string | null }>();
	for (const row of results ?? []) {
		let cfg: Record<string, unknown> = {};
		let readable = true;
		try {
			cfg = JSON.parse(row.config || "{}") as Record<string, unknown>;
		} catch {
			readable = false;
		}
		const named = typeof cfg.name === "string" && cfg.name.trim() ? cfg.name.trim() : null;
		out.set(row.id, {
			label: `"${named ?? row.agent_name ?? row.id}"`,
			inventory: readable ? pipelineInventory(cfg.pipelines) : null,
		});
	}
	return out;
}

/** The warnings a stored edge deserves right now. Today that is the target's pipeline (#363);
 *  the connector-wiring warnings (#181) stay on the create path, where they cost one read. */
function storedWarnings(row: ConnectionRow, facts: TargetFacts | undefined): string[] {
	if (row.action !== "run_pipeline") return [];
	const config = parseConfigJson(row.config);
	const warning = connectionPipelineWarning(typeof config.pipeline === "string" ? config.pipeline : null, facts?.label ?? "", facts?.inventory ?? null);
	return warning ? [warning] : [];
}

/**
 * List the caller's connections, most recent first; optionally scoped to one source instance.
 *
 * Each row carries its own `warnings` (#363). Rows written before the create-time check existed
 * may already name a pipeline their target does not have, and the listing is the only place that
 * can say so — deleting someone's connection for them is not ours to do, surfacing it as broken
 * is, which is the call #358 made for the same class of already-invalid row.
 */
export async function listConnections(env: Env, userId: string, opts: { sourceInstanceId?: string } = {}): Promise<ConnectionView[]> {
	const sql = opts.sourceInstanceId
		? "SELECT * FROM agent_connections WHERE user_id = ?1 AND source_instance_id = ?2 ORDER BY created_at DESC"
		: "SELECT * FROM agent_connections WHERE user_id = ?1 ORDER BY created_at DESC";
	const stmt = opts.sourceInstanceId ? env.DB.prepare(sql).bind(userId, opts.sourceInstanceId) : env.DB.prepare(sql).bind(userId);
	const { results } = await stmt.all<ConnectionRow>();
	const rows = results ?? [];
	// Only `run_pipeline` names something whose existence can be checked; the other actions
	// dispatch into the target's own DO, which every instance has.
	const targets = rows.filter((r) => r.action === "run_pipeline").map((r) => r.target_instance_id);
	// An annotation must never take the listing down with it: a failed read leaves every row
	// unannotated, which is exactly what the listing did before this existed.
	const facts = await targetFactsFor(env, userId, targets).catch(() => new Map<string, TargetFacts>());
	return rows.map((row) => toView(row, storedWarnings(row, facts.get(row.target_instance_id))));
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
		// The VALUE's type matters as much as the op. `evalClause` requires both sides to be
		// numbers for gt/gte/lt/lte and both strings for contains, so `{op:"gte", value:"4"}` — the
		// natural result of a text input or a hand-written JSON body — is a guaranteed false. The
		// connection is then created, shows enabled and healthy, and silently drops every event:
		// exactly the never-matches failure this function exists to catch.
		if ((c.op === "gt" || c.op === "gte" || c.op === "lt" || c.op === "lte") && typeof c.value !== "number") {
			return `filter clause ${i}: "${c.op}" compares numbers, so value must be a number (got ${typeof c.value}) — it would never match`;
		}
		if (c.op === "contains" && typeof c.value !== "string") {
			return `filter clause ${i}: "contains" compares strings, so value must be a string (got ${typeof c.value}) — it would never match`;
		}
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
): Promise<{ ok: true; connection: ConnectionView; warnings: string[] } | { ok: false; status: number; error: string }> {
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
	const warnings = await unattendedWarningsFor(env, userId, input.targetInstanceId, input.action, input.config);
	// The same list on the view and beside it: the create response and the later listing then say
	// the same thing about the same edge, which is the drift #358 spent its design on avoiding.
	return { ok: true, connection: toView(row as ConnectionRow, warnings), warnings };
}

/**
 * Warnings about this edge, computed while the human is still present.
 *
 * Two of them, both about `run_pipeline` and both advisory:
 *
 *  • the named pipeline does not exist on the target (#363) — a typo, a rename, or an edge
 *    pointed at the wrong agent. The one case that most deserved a warning used to produce
 *    none, because the lookup below opened with `if (!def) return []`;
 *  • a connector on the pipeline's path cannot survive unattended (#181).
 *
 * Warnings, not errors — the same call `validateConnectionFilter` makes about a filter, and for
 * the same reason: a chain that looks healthy but cannot run is worse than one that says so. A
 * connection fires with nobody present, so an `interactive-only` credential anywhere on the
 * target's path means the chain works until the token lapses and then stops. And a pipeline can
 * legitimately be added to the target after the edge is wired, which is why the missing-pipeline
 * case stays a warning rather than becoming a 400.
 *
 * Reach is honest about its limit: only `run_pipeline` names something whose existence and whose
 * connectors can be resolved statically. The other actions (`insert_record`, `create_task`,
 * `add_knowledge`) dispatch into the target's own Durable Object, which every instance has, and
 * have no external credential to lose.
 */
async function unattendedWarningsFor(
	env: Env,
	userId: string,
	targetInstanceId: string,
	action: TriggerAction,
	config: Record<string, unknown> | undefined,
): Promise<string[]> {
	if (action !== "run_pipeline") return [];
	const name = typeof config?.pipeline === "string" ? config.pipeline.trim() : "";
	// No name at all is under-specified, not provably broken: `executeTriggerAction` lets the
	// event PAYLOAD carry its own `pipeline`, so an edge without `config.pipeline` can still run.
	if (!name) return [];
	try {
		const def = await loadPipeline(env, targetInstanceId, userId, name);
		if (!def) {
			// #363: the pipeline is not there. Say so NOW, naming it and the agent it was looked
			// for on — the alternative is a dead letter hours later on an edge that looked healthy.
			const facts = (await targetFactsFor(env, userId, [targetInstanceId])).get(targetInstanceId);
			const warning = connectionPipelineWarning(name, facts?.label ?? "", facts?.inventory ?? null);
			return warning ? [warning] : [];
		}
		const used = connectorsUsedByPipeline(def.steps, (tool) => getRegistryTool(tool)?.connector);
		return pipelineWiringWarnings(used, getConnector, "connection");
	} catch {
		// A warning is advisory; failing to compute one must never fail the create.
		return [];
	}
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
			const claim = await enqueueDelivery(env, {
				connectionId: conn.id,
				userId: conn.user_id,
				sourceInstanceId,
				targetInstanceId: conn.target_instance_id,
				eventType,
				action: conn.action,
				payload,
				config,
				traceId: opts.traceId ?? null,
				claimedInline: true, // attempted immediately below — keep the cron off it meanwhile
			});
			if (!claim) {
				// The idempotency key collided: this exact emission is already recorded.
				duplicate++;
				continue;
			}
			queued++;
			const outcome = await attemptDelivery(env, {
				claim,
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
	/** This attempt's claim on the outbox row — presented on the terminal write so a slow
	 *  attempt can't overwrite an outcome another attempt already recorded (#239). */
	claim: DeliveryClaim;
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
	/** Which kind of edge produced this (#17). Only affects how the failure is LABELLED — the
	 *  retry mechanics are identical, which is the point of sharing one outbox. */
	source?: "connection" | "trigger";
}

/**
 * Run one delivery's action and record the outcome on its outbox row. Never throws — the
 * emitter must not fail because a consumer did, and the sweep must not stop on one bad row.
 */
export async function attemptDelivery(env: Env, input: AttemptInput): Promise<"delivered" | "retrying" | "dead" | "stale"> {
	try {
		await executeTriggerAction(
			env,
			{
				// The producing edge's id. `connectionId` IS the trigger id when source is
				// "trigger" (the outbox is shared, #17). Omitting it meant a retried
				// `sync_connector` reconstructed a target with `id: undefined`, and
				// `syncConnectorTrigger` uses `trigger.id` as the primary key of
				// `agent_trigger_sync_state` (TEXT NOT NULL) — so the retry died on a D1 bind
				// error unrelated to the outage that caused it, outside the per-item try, and
				// every attempt failed identically until the row dead-lettered with a misleading
				// last_error. Replaying it then failed the same way, forever.
				id: input.connectionId,
				action: input.action as TriggerAction,
				name: `connection:${input.eventType}`,
				instance_id: input.targetInstanceId,
				user_id: input.userId,
			},
			// The emitting run's id rides along so the target's run joins the same trace.
			{ ...input.config, traceId: input.traceId ?? undefined },
			"webhook",
			input.payload,
		);
		// A stale claim means another attempt already settled this row while this one was in
		// flight. Report it rather than writing over that outcome — and log it, because a
		// delivery slow enough to outlive a 5-minute hold is worth seeing.
		if (!(await markDelivered(env, input.claim))) {
			await logEvent(env, {
				source: input.source === "trigger" ? "trigger" : "connection",
				event: "connection.delivery_stale",
				level: "warn",
				message: "attempt succeeded but its claim had lapsed — another attempt already settled this delivery; outcome not overwritten",
				userId: input.userId,
				instanceId: input.sourceInstanceId,
				traceId: input.traceId ?? undefined,
				context: { deliveryId: input.claim.id, connectionId: input.connectionId, eventType: input.eventType, action: input.action },
			}).catch(() => undefined);
			return "stale";
		}
		return "delivered";
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// #181: an expired/rejected credential is not a transient outage. Retrying it is
		// guaranteed to fail, so it dead-letters at once with a message naming the fix, instead
		// of burning five attempts over ~4.25 hours and then reporting a transport error.
		const failure = classifyDeliveryFailure(message, statusOf(err));
		const outcome = await markAttemptFailed(env, input.claim, input.attempts, message, new Date(), failure);
		const kind = input.source === "trigger" ? "trigger" : "connection";
		const deadMessage =
			failure === "auth"
				? reconnectMessage("This connection's connector", message)
				: `gave up after ${MAX_ATTEMPTS} attempts: ${message}`;
		await logEvent(env, {
			// Label by the producing edge so a human reading the trace can tell a stuck trigger
			// from a stuck connection; they are the same mechanism but not the same problem.
			source: kind,
			event: outcome === "dead" ? `${kind}.delivery_dead` : `${kind}.delivery_retry`,
			level: "error",
			message: outcome === "dead" ? deadMessage : message,
			userId: input.userId,
			instanceId: input.sourceInstanceId,
			traceId: input.traceId ?? undefined,
			context: {
				deliveryId: input.claim.id,
				connectionId: input.connectionId,
				eventType: input.eventType,
				action: input.action,
				targetInstanceId: input.targetInstanceId,
				attempts: input.attempts + 1,
				// So a dead-letter list can separate "reconnect something" from "a dependency was down".
				failure,
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
export async function runDueDeliveries(env: Env, now = new Date(), limit = 25): Promise<{ checked: number; delivered: number; retrying: number; dead: number; stale: number }> {
	const due = await dueDeliveries(env, now, limit);
	let delivered = 0;
	let retrying = 0;
	let dead = 0;
	let stale = 0;
	for (const row of due) {
		// Claim before attempting, or an overlapping tick (or the enqueuer's own inline attempt)
		// executes the same delivery a second time — a `run_pipeline` consumer would build and
		// bill twice. See claimDelivery. The claim is carried into the attempt so its terminal
		// write can't land on a row someone else has since settled (#239).
		const claim = await claimDelivery(env, row, now);
		if (!claim) continue;
		let payload: unknown = null;
		try {
			payload = JSON.parse(row.payload);
		} catch {
			/* a payload we can't parse is delivered as null rather than wedging the sweep */
		}
		const outcome = await attemptDelivery(env, {
			claim,
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
			source: row.source === "trigger" ? "trigger" : "connection",
		});
		if (outcome === "delivered") delivered++;
		else if (outcome === "dead") dead++;
		else if (outcome === "stale") stale++;
		else retrying++;
	}
	return { checked: due.length, delivered, retrying, dead, stale };
}
