import { clipMarked } from "./clip-marked.js";
import { type Keyset, keysetCursor, olderThan } from "./keyset-cursor.js";
import type { Env } from "../types.js";
import { withinConfirmationWindow } from "./confirmation-window.js";
import { dispositionFrom, recordLifecycle } from "./objective-lifecycle.js";

export type LoopStartState = "provisioning" | "started" | "queued" | "not_started" | "unknown";
interface ReceiptRow {
	request_id: string;
	input_json: string;
	state: LoopStartState;
	response_json: string | null;
	response_status: number | null;
	created_at: number;
	updated_at: number;
}

function receiptView(row: ReceiptRow) {
	// A crashed Worker cannot settle its receipt. Age never proves it failed or that retry is safe.
	const ageMs = Math.max(0, Date.now() - row.updated_at);
	const startState = row.state === "provisioning" && ageMs > 5 * 60_000 ? "unknown" : row.state;
	return { requestId: row.request_id, startState, approval: "dispatched", createdAt: row.created_at, updatedAt: row.updated_at, ageMs };
}

/** One page of start receipts — {@link countLoopStarts} says how many there are in all (#954). */
export const LOOP_STARTS_PAGE = 20;

/**
 * A page of receipts, newest first, each with what became of it (#1017).
 *
 * `result` is what the caller was TOLD (the receipt, immutable); `current` is what is true NOW, read
 * from the queue entry and run the receipt led to — joined through the settled response's own handles,
 * so a receipt written before migration 0212 resolves too. `attribution` is the verified owner, or
 * `unknown` for a receipt from before attribution was recorded. Ties on `created_at` order by request
 * id, so a page boundary never moves.
 */
export async function listLoopStarts(env: Env, userId: string, instanceId: string, offset = 0, after: Keyset | null = null, limit = LOOP_STARTS_PAGE) {
	// `after` is a keyset cursor (#1017): receipts strictly older than the last one the reader saw.
	const keyset = after ? ` AND ${olderThan("r.created_at", "r.request_id", 5)}` : "";
	const rows = await env.DB.prepare(
		`SELECT r.*, q.id AS q_id, q.status AS q_status, q.stop_reason AS q_reason, q.run_id AS q_run,
		        lr.run_id AS lr_run, lr.status AS lr_status, lr.stop_reason AS lr_reason
		   FROM loop_start_receipts r
		   LEFT JOIN instance_objective_queue q
		     ON q.user_id = r.user_id AND q.instance_id = r.instance_id
		    AND q.id = COALESCE(json_extract(r.response_json, '$.entry.id'), json_extract(r.response_json, '$.duplicate_of'))
		   LEFT JOIN agent_loop_runs lr
		     ON lr.user_id = r.user_id AND lr.instance_id = r.instance_id
		    AND lr.run_id = COALESCE(json_extract(r.response_json, '$.runId'), q.run_id)
		  WHERE r.user_id = ?1 AND r.instance_id = ?2${keyset}
		  ORDER BY r.created_at DESC, r.request_id DESC LIMIT ?3 OFFSET ?4`,
	)
		.bind(userId, instanceId, limit, after ? 0 : Math.max(0, Math.trunc(offset) || 0), ...(after ? [after.at, after.id] : []))
		.all<ReceiptRow & JoinedRow>();
	return rows.results.map((row) => {
		const result = row.response_json ? JSON.parse(row.response_json) as Record<string, unknown> : null;
		const receiptReason = result ? (typeof result.error === "string" ? clipMarked(result.error, 300) : typeof result.reason === "string" ? result.reason : null) : null;
		const current = dispositionFrom({
			receiptState: row.state,
			queueEntry: row.q_id ? { id: row.q_id, status: row.q_status ?? "", stop_reason: row.q_reason ?? null, run_id: row.q_run ?? null } : null,
			run: row.lr_run ? { run_id: row.lr_run, status: row.lr_status ?? "", stop_reason: row.lr_reason ?? null } : null,
			receiptReason,
		});
		const attribution = row.actor_uid ? { kind: "owner" as const, uid: row.actor_uid, verified: true as const, clientClaimed: row.client_claimed ?? null } : { kind: "unknown" as const, legacy: true as const };
		return { ...receiptView(row), attribution, current, ...(result ? { result: { runId: result.runId ?? null, queueEntryId: (result.entry as { id?: string } | undefined)?.id ?? null, duplicate_of: typeof result.duplicate_of === "string" ? result.duplicate_of : null, reason: result.reason ?? null, error: typeof result.error === "string" ? clipMarked(result.error, 500) : null } } : {}) };
	});
}

interface JoinedRow {
	actor_uid?: string | null;
	client_claimed?: string | null;
	q_id: string | null;
	q_status: string | null;
	q_reason: string | null;
	q_run: string | null;
	lr_run: string | null;
	lr_status: string | null;
	lr_reason: string | null;
}

/** Every start receipt on the instance — so the newest page never reads as all of them (#954). */
export async function countLoopStarts(env: Env, userId: string, instanceId: string): Promise<number> {
	const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM loop_start_receipts WHERE user_id = ? AND instance_id = ?").bind(userId, instanceId).first<{ n: number }>();
	return Number(row?.n ?? 0);
}

/**
 * A page of receipts with its place in the whole (#954) — the newest 20 used to be all a caller saw.
 *
 * `startsNextCursor` (#1017) is the stable continuation: pass it back as `starts_cursor` and the next
 * page starts strictly after the last receipt returned, whatever was inserted or deleted meanwhile.
 * `starts_offset` still works and is the WEAKER contract — a receipt written between two offset reads
 * shifts the second page and repeats a row — kept so an existing caller does not break.
 */
export async function loopStartsPage(env: Env, userId: string, instanceId: string, offset: number, after: Keyset | null = null) {
	const startsOffset = after ? 0 : Math.max(0, Math.trunc(offset) || 0);
	const [rows, startsTotal] = await Promise.all([listLoopStarts(env, userId, instanceId, startsOffset, after, LOOP_STARTS_PAGE + 1), countLoopStarts(env, userId, instanceId)]);
	// One row past the page was read only to know whether more exist; it is dropped, never cut from a value.
	const more = rows.length > LOOP_STARTS_PAGE;
	const starts = more ? rows.slice(0, -1) : rows;
	const last = starts[starts.length - 1];
	const startsNextCursor = more && last ? keysetCursor(last.createdAt, last.requestId) : null;
	const startsNextOffset = !after && more ? startsOffset + starts.length : null;
	return { starts, startsTotal, startsOffset, startsNextOffset, startsNextCursor, startsComplete: !more };
}

/** Bound confirmation without abandoning the durable start when the caller disconnects. */
export function dispatchLoopStartReceipt(env: Env, userId: string, instanceId: string, requestId: string, input: unknown, start: () => Promise<Response>, keepAlive: (operation: Promise<unknown>) => void, clientClaimed: string | null = null): Promise<Response> {
	return withinConfirmationWindow(
		withLoopStartReceipt(env, userId, instanceId, requestId, input, start, clientClaimed),
		() => Response.json({ requestId, startState: "provisioning", approval: "dispatched", polling: { tool: "coding_loop_status", instance_id: instanceId }, guidance: "This request is being processed. Poll its receipt or reuse this requestId with the same arguments; do not submit a new request." }, { status: 202 }),
		keepAlive,
	);
}

/** An exact request key replays its result; another request's lock never implies our start landed.
 * Provisioning is a durable observation, not a promise of background execution. If the Worker dies,
 * it remains unresolved and MUST NOT be automatically re-executed; an owner can reconcile the run.
 */
export async function withLoopStartReceipt(env: Env, userId: string, instanceId: string, requestId: string, input: unknown, start: () => Promise<Response>, clientClaimed: string | null = null): Promise<Response> {
	const inputJson = JSON.stringify(input);
	const now = Date.now();
	// The verified session uid is the actor (#1017); the request key is the caller's own text and never one.
	const actor = { kind: "owner" as const, uid: userId, clientClaimed };
	const inserted = await env.DB.prepare("INSERT OR IGNORE INTO loop_start_receipts (user_id, instance_id, request_id, input_json, state, created_at, updated_at, actor_uid, client_claimed) VALUES (?, ?, ?, ?, 'provisioning', ?, ?, ?, ?)").bind(userId, instanceId, requestId, inputJson, now, now, userId, clientClaimed).run();
	if (inserted.meta.changes) await recordLifecycle(env, { userId, instanceId, requestId, event: "requested", actor, now });
	if (!inserted.meta.changes) {
		await recordLifecycle(env, { userId, instanceId, requestId, event: "request_replayed", actor });
		const row = await env.DB.prepare("SELECT * FROM loop_start_receipts WHERE user_id = ? AND instance_id = ? AND request_id = ?").bind(userId, instanceId, requestId).first<ReceiptRow>();
		if (!row) throw new Error("start receipt disappeared");
		if (row.input_json !== inputJson) return Response.json({ error: "requestId already belongs to a different start; use the original arguments to reconcile it", ...receiptView(row), reason: "request_key_conflict", submissionState: "not_started", originalStart: receiptView(row) }, { status: 409 });
		if (row.response_json) return Response.json(JSON.parse(row.response_json), { status: row.response_status ?? 200 });
		return Response.json({ ...receiptView(row), polling: { tool: "coding_loop_status", instance_id: instanceId }, guidance: "This request reached the platform and is provisioning or awaiting reconciliation. Poll status; do not submit a new request to infer whether it started." }, { status: 202 });
	}
	try {
		const response = await start();
		const body = await response.clone().json() as Record<string, unknown>;
		const state: LoopStartState = body.queued === true ? "queued" : typeof body.runId === "string" && response.ok ? "started" : "not_started";
		const result = { ...body, requestId, startState: state, approval: "dispatched" };
		await settle(state, result, response.status);
		return Response.json(result, { status: response.status });
	} catch {
		// An exception may follow a successfully dispatched Workflow: never claim no effect.
		const result = { error: "Start outcome could not be confirmed", requestId, startState: "unknown", approval: "dispatched", polling: { tool: "coding_loop_status", instance_id: instanceId }, guidance: "Poll status and reconcile this request before attempting another start." };
		await settle("unknown", result, 503);
		await recordLifecycle(env, { userId, instanceId, requestId, event: "outcome_unknown", actor });
		return Response.json(result, { status: 503 });
	}
	async function settle(state: LoopStartState, result: unknown, status: number) {
		await env.DB.prepare("UPDATE loop_start_receipts SET state = ?, response_json = ?, response_status = ?, updated_at = ? WHERE user_id = ? AND instance_id = ? AND request_id = ?").bind(state, JSON.stringify(result), status, Date.now(), userId, instanceId, requestId).run();
	}
}
