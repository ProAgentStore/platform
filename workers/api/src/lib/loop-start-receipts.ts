import { clipMarked } from "./clip-marked.js";
import type { Env } from "../types.js";
import { withinConfirmationWindow } from "./confirmation-window.js";

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

export async function listLoopStarts(env: Env, userId: string, instanceId: string, offset = 0) {
	const rows = await env.DB.prepare("SELECT * FROM loop_start_receipts WHERE user_id = ? AND instance_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
		.bind(userId, instanceId, LOOP_STARTS_PAGE, Math.max(0, Math.trunc(offset)))
		.all<ReceiptRow>();
	return rows.results.map((row) => {
		const result = row.response_json ? JSON.parse(row.response_json) as Record<string, unknown> : null;
		return { ...receiptView(row), ...(result ? { result: { runId: result.runId ?? null, queueEntryId: (result.entry as { id?: string } | undefined)?.id ?? null, reason: result.reason ?? null, error: typeof result.error === "string" ? clipMarked(result.error, 500) : null } } : {}) };
	});
}

/** Every start receipt on the instance — so the newest page never reads as all of them (#954). */
export async function countLoopStarts(env: Env, userId: string, instanceId: string): Promise<number> {
	const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM loop_start_receipts WHERE user_id = ? AND instance_id = ?").bind(userId, instanceId).first<{ n: number }>();
	return Number(row?.n ?? 0);
}

/** A page of receipts with its place in the whole (#954) — the newest 20 used to be all a caller saw. */
export async function loopStartsPage(env: Env, userId: string, instanceId: string, offset: number) {
	const startsOffset = Math.max(0, Math.trunc(offset) || 0);
	const [starts, startsTotal] = await Promise.all([listLoopStarts(env, userId, instanceId, startsOffset), countLoopStarts(env, userId, instanceId)]);
	return { starts, startsTotal, startsOffset, startsNextOffset: startsOffset + starts.length < startsTotal ? startsOffset + starts.length : null };
}

/** Bound confirmation without abandoning the durable start when the caller disconnects. */
export function dispatchLoopStartReceipt(env: Env, userId: string, instanceId: string, requestId: string, input: unknown, start: () => Promise<Response>, keepAlive: (operation: Promise<unknown>) => void): Promise<Response> {
	return withinConfirmationWindow(
		withLoopStartReceipt(env, userId, instanceId, requestId, input, start),
		() => Response.json({ requestId, startState: "provisioning", approval: "dispatched", polling: { tool: "coding_loop_status", instance_id: instanceId }, guidance: "This request is being processed. Poll its receipt or reuse this requestId with the same arguments; do not submit a new request." }, { status: 202 }),
		keepAlive,
	);
}

/** An exact request key replays its result; another request's lock never implies our start landed.
 * Provisioning is a durable observation, not a promise of background execution. If the Worker dies,
 * it remains unresolved and MUST NOT be automatically re-executed; an owner can reconcile the run.
 */
export async function withLoopStartReceipt(env: Env, userId: string, instanceId: string, requestId: string, input: unknown, start: () => Promise<Response>): Promise<Response> {
	const inputJson = JSON.stringify(input);
	const now = Date.now();
	const inserted = await env.DB.prepare("INSERT OR IGNORE INTO loop_start_receipts (user_id, instance_id, request_id, input_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'provisioning', ?, ?)").bind(userId, instanceId, requestId, inputJson, now, now).run();
	if (!inserted.meta.changes) {
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
		return Response.json(result, { status: 503 });
	}
	async function settle(state: LoopStartState, result: unknown, status: number) {
		await env.DB.prepare("UPDATE loop_start_receipts SET state = ?, response_json = ?, response_status = ?, updated_at = ? WHERE user_id = ? AND instance_id = ? AND request_id = ?").bind(state, JSON.stringify(result), status, Date.now(), userId, instanceId, requestId).run();
	}
}
