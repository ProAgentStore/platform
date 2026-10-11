/**
 * The objective lifecycle ledger (#1017): every transition an objective goes through, owner-scoped,
 * append-only, cursor-paged.
 *
 *     request receipt -> queue entry -> admitted | deferred | cancelled | admission_failed -> run -> run_finished
 *
 * The receipt (`loop_start_receipts`) stays as it settled — it is the immutable record of what the
 * caller was told. This ledger is the history that came after, and `currentDisposition` is the
 * present tense read from the joins, so a receipt that said `queued` can now say what became of it.
 *
 * ── Attribution
 *
 * `owner` events carry `actorUid`: the session uid, verified by the session HMAC — the only identity
 * the platform can actually prove. `clientClaimed` is the client category the caller DECLARED in
 * `X-PAGS-Client`; it is reported as a claim, because a session token does not say which client sent
 * it. `platform` events are the platform's own transitions (a queue drain, a run ending). A request key
 * is caller-chosen text and is never read as an identity. Rows written before migration 0212 have no
 * attribution and read back as `unknown`.
 *
 * Recording is BEST-EFFORT: a transition that happened is never undone because its history row could
 * not be written. A gap is visible — the joins in `currentDisposition` do not depend on this table.
 */
import type { Env } from "../types.js";
import { clipMarked } from "./clip-marked.js";

export const LIFECYCLE_EVENTS = [
	"requested",
	"request_replayed",
	"started",
	"queued",
	"deduplicated",
	"not_started",
	"outcome_unknown",
	"admitted",
	"deferred",
	"admission_failed",
	"cancelled",
	"run_finished",
] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

/** Client categories a caller may declare. Anything else is recorded as no claim at all. */
const CLIENT_CLAIMS = new Set(["mcp", "console", "cli"]);

export function clientClaimFrom(header: string | null | undefined): string | null {
	const v = (header ?? "").trim().toLowerCase();
	return CLIENT_CLAIMS.has(v) ? v : null;
}

/** Who caused a transition, as far as the platform can verify. */
export type LifecycleActor = { kind: "owner"; uid: string; clientClaimed: string | null } | { kind: "platform" };

export interface LifecycleInput {
	userId: string;
	instanceId: string;
	event: LifecycleEvent;
	actor: LifecycleActor;
	requestId?: string | null;
	queueEntryId?: string | null;
	runId?: string | null;
	sessionId?: string | null;
	reason?: string | null;
	now?: number;
}

export async function recordLifecycle(env: Env, e: LifecycleInput): Promise<void> {
	try {
		await env.DB.prepare(
			`INSERT INTO objective_lifecycle_events
			 (user_id, instance_id, request_id, queue_entry_id, run_id, session_id, event, reason, actor_kind, actor_uid, client_claimed, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
		)
			.bind(
				e.userId,
				e.instanceId,
				e.requestId ?? null,
				e.queueEntryId ?? null,
				e.runId ?? null,
				e.sessionId ?? null,
				e.event,
				e.reason ? clipMarked(e.reason, 300) : null,
				e.actor.kind,
				e.actor.kind === "owner" ? e.actor.uid : null,
				e.actor.kind === "owner" ? e.actor.clientClaimed : null,
				e.now ?? Date.now(),
			)
			.run();
	} catch {
		// Best-effort by design (see header): the transition itself already happened.
	}
}

export interface LifecycleView {
	seq: number;
	event: LifecycleEvent;
	at: number;
	requestId: string | null;
	queueEntryId: string | null;
	runId: string | null;
	sessionId: string | null;
	reason: string | null;
	actor: { kind: "owner"; uid: string; verified: true; clientClaimed: string | null } | { kind: "platform" };
}

interface LifecycleRow {
	seq: number;
	request_id: string | null;
	queue_entry_id: string | null;
	run_id: string | null;
	session_id: string | null;
	event: LifecycleEvent;
	reason: string | null;
	actor_kind: "owner" | "platform";
	actor_uid: string | null;
	client_claimed: string | null;
	created_at: number;
}

function toView(r: LifecycleRow): LifecycleView {
	return {
		seq: r.seq,
		event: r.event,
		at: r.created_at,
		requestId: r.request_id,
		queueEntryId: r.queue_entry_id,
		runId: r.run_id,
		sessionId: r.session_id,
		reason: r.reason,
		actor: r.actor_kind === "owner" && r.actor_uid ? { kind: "owner", uid: r.actor_uid, verified: true, clientClaimed: r.client_claimed } : { kind: "platform" },
	};
}

export interface LifecycleFilter {
	requestId?: string;
	queueEntryId?: string;
	runId?: string;
}

export const LIFECYCLE_PAGE_MAX = 100;

/**
 * One page of an instance's lifecycle history, OLDEST first (it is a history), after `afterSeq`.
 *
 * A filter on any one handle EXPANDS to the objective it belongs to: asking by request id also
 * returns its queue entry's and its run's events, so one objective's whole history is reconstructed
 * from whichever handle the caller holds — and nothing outside it is fetched.
 */
export async function listLifecycle(
	env: Env,
	input: { userId: string; instanceId: string; filter?: LifecycleFilter; afterSeq?: number; limit?: number },
): Promise<{ events: LifecycleView[]; nextCursor: number | null; complete: boolean }> {
	const limit = Math.max(1, Math.min(LIFECYCLE_PAGE_MAX, input.limit ?? 50));
	const handles = input.filter && (input.filter.requestId || input.filter.queueEntryId || input.filter.runId) ? await expandHandles(env, input.userId, input.instanceId, input.filter) : null;
	const where = ["user_id = ?1", "instance_id = ?2", "seq > ?3"];
	const binds: unknown[] = [input.userId, input.instanceId, input.afterSeq ?? 0];
	if (handles) {
		const ors: string[] = [];
		for (const [col, values] of [
			["request_id", handles.requestIds],
			["queue_entry_id", handles.queueEntryIds],
			["run_id", handles.runIds],
		] as const) {
			for (const v of values) {
				binds.push(v);
				ors.push(`${col} = ?${binds.length}`);
			}
		}
		where.push(ors.length ? `(${ors.join(" OR ")})` : "0");
	}
	binds.push(limit + 1);
	const rows = await env.DB.prepare(`SELECT * FROM objective_lifecycle_events WHERE ${where.join(" AND ")} ORDER BY seq ASC LIMIT ?${binds.length}`)
		.bind(...binds)
		.all<LifecycleRow>();
	const all = (rows.results ?? []).map(toView);
	const page = all.slice(0, limit);
	const more = all.length > limit;
	return { events: page, nextCursor: more ? page[page.length - 1].seq : null, complete: !more };
}

/** Every handle of the objective `filter` names, found through the stored links (owner-scoped). */
async function expandHandles(env: Env, userId: string, instanceId: string, filter: LifecycleFilter) {
	const requestIds = new Set<string>(filter.requestId ? [filter.requestId] : []);
	const queueEntryIds = new Set<string>(filter.queueEntryId ? [filter.queueEntryId] : []);
	const runIds = new Set<string>(filter.runId ? [filter.runId] : []);
	// Two passes reach a fixed point: request -> entry/run, entry -> request/run, run -> entry/request.
	for (let pass = 0; pass < 2; pass++) {
		for (const id of [...queueEntryIds]) {
			const q = await env.DB.prepare("SELECT request_id, run_id FROM instance_objective_queue WHERE id = ?1 AND user_id = ?2 AND instance_id = ?3").bind(id, userId, instanceId).first<{ request_id: string | null; run_id: string | null }>();
			if (q?.request_id) requestIds.add(q.request_id);
			if (q?.run_id) runIds.add(q.run_id);
		}
		for (const id of [...runIds]) {
			const r = await env.DB.prepare("SELECT queue_entry_id, request_id FROM agent_loop_runs WHERE run_id = ?1 AND user_id = ?2 AND instance_id = ?3").bind(id, userId, instanceId).first<{ queue_entry_id: string | null; request_id: string | null }>();
			if (r?.queue_entry_id) queueEntryIds.add(r.queue_entry_id);
			if (r?.request_id) requestIds.add(r.request_id);
		}
		for (const id of [...requestIds]) {
			const q = await env.DB.prepare("SELECT id, run_id FROM instance_objective_queue WHERE request_id = ?1 AND user_id = ?2 AND instance_id = ?3").bind(id, userId, instanceId).all<{ id: string; run_id: string | null }>();
			for (const row of q.results ?? []) {
				queueEntryIds.add(row.id);
				if (row.run_id) runIds.add(row.run_id);
			}
			const r = await env.DB.prepare("SELECT run_id FROM agent_loop_runs WHERE request_id = ?1 AND user_id = ?2 AND instance_id = ?3").bind(id, userId, instanceId).all<{ run_id: string }>();
			for (const row of r.results ?? []) runIds.add(row.run_id);
		}
	}
	return { requestIds: [...requestIds], queueEntryIds: [...queueEntryIds], runIds: [...runIds] };
}

/**
 * What became of a start request, in the present tense, read from the joins (never from the receipt's
 * own frozen `state`). One explainable answer per receipt.
 */
export type Disposition =
	| { state: "running" | "completed" | "failed" | "needs_human" | "cancelled"; runId: string; queueEntryId: string | null; stopReason: string | null }
	| { state: "pending" | "claimed"; queueEntryId: string; reason: string | null }
	| { state: "queue_cancelled" | "admission_failed"; queueEntryId: string; reason: string | null }
	| { state: "not_started" | "provisioning" | "outcome_unknown"; reason: string | null };

export function dispositionFrom(input: {
	receiptState: string;
	queueEntry: { id: string; status: string; stop_reason: string | null; run_id: string | null } | null;
	run: { run_id: string; status: string; stop_reason: string | null } | null;
	receiptReason: string | null;
}): Disposition {
	const { run, queueEntry } = input;
	if (run) return { state: run.status as "running", runId: run.run_id, queueEntryId: queueEntry?.id ?? null, stopReason: run.stop_reason };
	if (queueEntry) {
		if (queueEntry.status === "pending") return { state: "pending", queueEntryId: queueEntry.id, reason: queueEntry.stop_reason };
		if (queueEntry.status === "running") return { state: "claimed", queueEntryId: queueEntry.id, reason: null };
		if (queueEntry.status === "cancelled") return { state: "queue_cancelled", queueEntryId: queueEntry.id, reason: queueEntry.stop_reason };
		if (queueEntry.status === "failed") return { state: "admission_failed", queueEntryId: queueEntry.id, reason: queueEntry.stop_reason };
	}
	if (input.receiptState === "provisioning") return { state: "provisioning", reason: null };
	if (input.receiptState === "unknown") return { state: "outcome_unknown", reason: input.receiptReason };
	return { state: "not_started", reason: input.receiptReason };
}

/**
 * Run one `POST /loop` start and record what it became (#1017): started, queued, deduplicated against
 * an existing objective, or not started. Links the run or queue entry back to the start request and
 * stamps the verified owner on a new queue entry. Never changes the response; an exception propagates
 * untouched so the receipt wrapper can record `outcome_unknown` honestly.
 */
export async function trackStartOutcome(
	env: Env,
	ctx: { userId: string; instanceId: string; requestId: string | null; clientClaimed: string | null },
	start: () => Promise<Response>,
): Promise<Response> {
	const response = await start();
	const body = (await response.clone().json().catch(() => null)) as Record<string, unknown> | null;
	if (!body) return response;
	const actor: LifecycleActor = { kind: "owner", uid: ctx.userId, clientClaimed: ctx.clientClaimed };
	const base = { userId: ctx.userId, instanceId: ctx.instanceId, requestId: ctx.requestId, actor };
	const dup = typeof body.duplicate_of === "string" ? body.duplicate_of : null;
	try {
		if (body.queued === true) {
			const entryId = (body.entry as { id?: string } | undefined)?.id ?? null;
			if (entryId && !dup) {
				await env.DB.prepare("UPDATE instance_objective_queue SET request_id = COALESCE(request_id, ?3), actor_uid = ?4, client_claimed = ?5 WHERE id = ?1 AND user_id = ?2")
					.bind(entryId, ctx.userId, ctx.requestId, ctx.userId, ctx.clientClaimed)
					.run();
			}
			await recordLifecycle(env, { ...base, event: dup ? "deduplicated" : "queued", queueEntryId: entryId, reason: typeof body.blocked === "string" ? body.blocked : null });
		} else if (typeof body.runId === "string" && response.ok) {
			if (!dup) await env.DB.prepare("UPDATE agent_loop_runs SET request_id = COALESCE(request_id, ?3) WHERE run_id = ?1 AND user_id = ?2").bind(body.runId, ctx.userId, ctx.requestId).run();
			await recordLifecycle(env, { ...base, event: dup ? "deduplicated" : "started", runId: body.runId });
		} else {
			const reason = typeof body.error === "string" ? body.error : typeof body.reason === "string" ? body.reason : null;
			await recordLifecycle(env, { ...base, event: "not_started", reason });
		}
	} catch {
		// The links are bookkeeping; the start's own answer stands either way.
	}
	return response;
}
