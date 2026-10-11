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
	/** `deferred` only: which deferral of the entry this is (#1017). Null on a row counted before 0218. */
	deferralSeq?: number | null;
}

export async function recordLifecycle(env: Env, e: LifecycleInput): Promise<void> {
	try {
		await env.DB.prepare(
			`INSERT INTO objective_lifecycle_events
			 (user_id, instance_id, request_id, queue_entry_id, run_id, session_id, event, reason, actor_kind, actor_uid, client_claimed, created_at, deferral_seq)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
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
				e.event === "deferred" ? (e.deferralSeq ?? null) : null,
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
): Promise<{ events: LifecycleView[]; nextCursor: number | null; complete: boolean } & LifecycleCoverage> {
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
	// `complete` is PAGING (no more events after this page); `coverage` is whether the history itself is whole.
	const coverage = handles ? await coverageOf(env, input.userId, input.instanceId, handles) : UNFILTERED_COVERAGE;
	return { events: page, nextCursor: more ? page[page.length - 1].seq : null, complete: !more, ...coverage };
}

/**
 * Whether one objective's recorded history is WHOLE (#1017) — a separate question from paging.
 *
 * Recording is best-effort (see the header), so a page that reaches the end of the stored events is not
 * evidence every transition was stored: a failed insert leaves a hole that paging cannot see. So the
 * objective's own rows — which ARE the transitions, and which the history only describes — are compared
 * with the events recorded for them, with no write of any kind:
 *
 *   a receipt with no `requested`, or one that settled deduplicated / not started / outcome unknown with
 *   no `deduplicated` / `not_started` / `outcome_unknown`; a queue entry with no `queued`, a cancelled /
 *   failed / admitted one with no `cancelled` / `admission_failed` / `admitted`, or a still-pending one
 *   carrying a deferral note with no `deferred`; a run with no `started` / `admitted`, or a finished one
 *   with no `run_finished`.
 *
 * Deferrals are COUNTED (#1017, migration 0218): a row queued since then carries `deferral_count`, and
 * each `deferred` event carries the ordinal of the deferral it records. Every ordinal 1..count must be
 * present, so one deferral of several being lost is a named gap whichever one it was, in every later
 * status. A repeated write of one deferral is one ordinal, and a requeue that moved nothing counts nothing.
 *
 * A row queued before 0218 has `deferral_count` NULL: how many times it was deferred is not known, so it
 * NEVER reads `complete` on deferral grounds. With evidence of a deferral — `deferred_at` (0216), or the
 * waiting note `requeueEntry` left on a pending or cancelled row (a cancel does not touch it) — and no
 * `deferred` event at all, it is a gap. Otherwise it reads `unknown`, because `finishQueueEntry` overwrites
 * the note, so an admitted or failed pre-0216 row may have been deferred with nothing left to show it.
 *
 * Each missing one is named in `coverage_gaps` and makes the coverage `incomplete`. A row older than the
 * instance's first recorded event predates the ledger (migration 0212) and reads `unknown` — never a gap
 * and never complete. A run started outside the tracked start paths (no request, no queue entry) has no
 * expected events either, so it reads `unknown` too.
 */
export interface LifecycleCoverage {
	coverage: "complete" | "incomplete" | "unknown";
	coverage_gaps: string[];
}

const UNFILTERED_COVERAGE: LifecycleCoverage = { coverage: "unknown", coverage_gaps: [] };

async function coverageOf(env: Env, userId: string, instanceId: string, h: { requestIds: string[]; queueEntryIds: string[]; runIds: string[] }): Promise<LifecycleCoverage> {
	const scope = "user_id = ?1 AND instance_id = ?2";
	const start = await env.DB.prepare(`SELECT MIN(created_at) AS at FROM objective_lifecycle_events WHERE ${scope}`).bind(userId, instanceId).first<{ at: number | null }>();
	const ledgerStart = start?.at ?? null;
	const recorded = new Set<string>();
	const note = (event: string, kind: string, id: string | null) => id && recorded.add(`${event}|${kind}|${id}`);
	/** Per queue entry: the deferral ordinals recorded, and how many `deferred` events carry none (pre-0218 writes). */
	const deferrals = new Map<string, { seqs: Set<number>; unsequenced: number }>();
	// One event can be reached through several handles; it is counted once, by the ledger's own `seq`.
	const seen = new Set<number>();
	for (const [col, ids] of [["request_id", h.requestIds], ["queue_entry_id", h.queueEntryIds], ["run_id", h.runIds]] as const) {
		for (const id of ids) {
			const rows = await env.DB.prepare(`SELECT seq, event, request_id, queue_entry_id, run_id, deferral_seq FROM objective_lifecycle_events WHERE ${scope} AND ${col} = ?3`)
				.bind(userId, instanceId, id)
				.all<{ seq: number; event: string; request_id: string | null; queue_entry_id: string | null; run_id: string | null; deferral_seq: number | null }>();
			for (const e of rows.results ?? []) {
				if (seen.has(e.seq)) continue;
				seen.add(e.seq);
				note(e.event, "r", e.request_id);
				note(e.event, "q", e.queue_entry_id);
				note(e.event, "u", e.run_id);
				if (e.event === "deferred" && e.queue_entry_id) {
					const d = deferrals.get(e.queue_entry_id) ?? { seqs: new Set<number>(), unsequenced: 0 };
					if (e.deferral_seq === null) d.unsequenced++;
					else d.seqs.add(e.deferral_seq);
					deferrals.set(e.queue_entry_id, d);
				}
			}
		}
	}
	const has = (events: string[], kind: string, id: string) => events.some((e) => recorded.has(`${e}|${kind}|${id}`));
	const gaps: string[] = [];
	let legacy = false;
	const predates = (at: number) => ledgerStart === null || at < ledgerStart;
	const expect = (at: number, events: string[], kind: string, id: string, what: string) => {
		if (has(events, kind, id)) return;
		if (predates(at)) legacy = true;
		else gaps.push(`${what}: no ${events.map((e) => `"${e}"`).join(" or ")} event`);
	};
	for (const id of h.requestIds) {
		const r = await env.DB.prepare(`SELECT created_at, state, response_json FROM loop_start_receipts WHERE ${scope} AND request_id = ?3`).bind(userId, instanceId, id).first<{ created_at: number; state: string; response_json: string | null }>();
		if (!r) continue;
		expect(r.created_at, ["requested"], "r", id, `request ${id}`);
		// The receipt's SETTLED state is a transition too: each one is recorded by its own best-effort write.
		const settled = r.response_json ? (JSON.parse(r.response_json) as { duplicate_of?: unknown }) : null;
		if (typeof settled?.duplicate_of === "string") expect(r.created_at, ["deduplicated"], "r", id, `request ${id} (deduplicated onto ${settled.duplicate_of})`);
		else if (r.state === "not_started") expect(r.created_at, ["not_started"], "r", id, `request ${id} (not started)`);
		if (r.state === "unknown") expect(r.created_at, ["outcome_unknown"], "r", id, `request ${id} (outcome unknown)`);
	}
	for (const id of h.queueEntryIds) {
		const q = await env.DB.prepare(`SELECT created_at, status, run_id, stop_reason, deferred_at, deferral_count FROM instance_objective_queue WHERE ${scope} AND id = ?3`)
			.bind(userId, instanceId, id)
			.first<{ created_at: number; status: string; run_id: string | null; stop_reason: string | null; deferred_at: number | null; deferral_count: number | null }>();
		if (!q) continue;
		expect(q.created_at, ["queued"], "q", id, `queue entry ${id}`);
		if (q.status === "cancelled") expect(q.created_at, ["cancelled"], "q", id, `queue entry ${id} (cancelled)`);
		if (q.status === "failed") expect(q.created_at, ["admission_failed"], "q", id, `queue entry ${id} (failed admission)`);
		if (q.run_id) expect(q.created_at, ["admitted"], "q", id, `queue entry ${id} (admitted to run ${q.run_id})`);
		const d = deferrals.get(id) ?? { seqs: new Set<number>(), unsequenced: 0 };
		if (q.deferral_count !== null) {
			// Counted (0218+): every deferral has its own event, whichever of them was lost.
			for (let n = 1; n <= q.deferral_count; n++) {
				if (d.seqs.has(n)) continue;
				const what = q.deferral_count === 1 ? `queue entry ${id} (deferred)` : `queue entry ${id} (deferral ${n} of ${q.deferral_count})`;
				if (predates(q.created_at)) legacy = true;
				else gaps.push(`${what}: no "deferred" event`);
			}
		} else {
			// Uncounted (queued before 0218). A cancel leaves the waiting note in place; admission and failure
			// overwrite it, so for those the absence of evidence is not evidence of no deferral.
			const evidenced = q.deferred_at !== null || ((q.status === "pending" || q.status === "cancelled") && !!q.stop_reason);
			if (evidenced && d.seqs.size + d.unsequenced === 0) expect(q.created_at, ["deferred"], "q", id, `queue entry ${id} (deferred)`);
			else legacy = true;
		}
	}
	for (const id of h.runIds) {
		const u = await env.DB.prepare(`SELECT started_at, status, request_id, queue_entry_id FROM agent_loop_runs WHERE ${scope} AND run_id = ?3`).bind(userId, instanceId, id).first<{ started_at: number; status: string; request_id: string | null; queue_entry_id: string | null }>();
		if (!u) continue;
		if (!u.request_id && !u.queue_entry_id && !has(["started", "admitted"], "u", id)) {
			legacy = true; // started outside the tracked paths: nothing was ever expected of it here
			continue;
		}
		expect(u.started_at, ["started", "admitted"], "u", id, `run ${id}`);
		if (u.status !== "running") expect(u.started_at, ["run_finished"], "u", id, `run ${id} (${u.status})`);
	}
	return { coverage: gaps.length ? "incomplete" : legacy || !recorded.size ? "unknown" : "complete", coverage_gaps: gaps };
}

/** Every handle of the objective `filter` names, found through the stored links (owner-scoped). */
async function expandHandles(env: Env, userId: string, instanceId: string, filter: LifecycleFilter) {
	const requestIds = new Set<string>(filter.requestId ? [filter.requestId] : []);
	const queueEntryIds = new Set<string>(filter.queueEntryId ? [filter.queueEntryId] : []);
	const runIds = new Set<string>(filter.runId ? [filter.runId] : []);
	// Links come from the rows AND from the immutable events (#1017): a DEDUPLICATED request is never
	// written onto the shared queue entry or run (they keep the original request's id), so the only link
	// from it to the objective it joined is its own `deduplicated` event — and the only link back from the
	// objective to it. Following both is what makes any handle, the duplicate's included, reach the whole
	// connected history. Iterated to a fixed point; bounded so a pathological chain cannot run on.
	const size = () => requestIds.size + queueEntryIds.size + runIds.size;
	for (let pass = 0, before = -1; pass < 8 && before !== size(); pass++) {
		before = size();
		const linked = async (col: "request_id" | "queue_entry_id" | "run_id", id: string) =>
			(await env.DB.prepare(`SELECT DISTINCT request_id, queue_entry_id, run_id FROM objective_lifecycle_events WHERE user_id = ?1 AND instance_id = ?2 AND ${col} = ?3`).bind(userId, instanceId, id).all<{ request_id: string | null; queue_entry_id: string | null; run_id: string | null }>()).results ?? [];
		// The receipt's settled response is immutable and names what the request led to — the entry, the
		// run, or what it was deduplicated onto — even when the link written onto that row was lost.
		for (const id of [...requestIds]) {
			const r = await env.DB.prepare("SELECT response_json FROM loop_start_receipts WHERE user_id = ?1 AND instance_id = ?2 AND request_id = ?3").bind(userId, instanceId, id).first<{ response_json: string | null }>();
			const body = r?.response_json ? (JSON.parse(r.response_json) as { runId?: unknown; entry?: { id?: unknown }; duplicate_of?: unknown; queued?: unknown }) : null;
			if (typeof body?.entry?.id === "string") queueEntryIds.add(body.entry.id);
			if (typeof body?.runId === "string") runIds.add(body.runId);
			if (typeof body?.duplicate_of === "string") (body.queued === true ? queueEntryIds : runIds).add(body.duplicate_of);
		}
		for (const [col, set] of [["request_id", requestIds], ["queue_entry_id", queueEntryIds], ["run_id", runIds]] as const) {
			for (const id of [...set]) {
				for (const e of await linked(col, id)) {
					if (e.request_id) requestIds.add(e.request_id);
					if (e.queue_entry_id) queueEntryIds.add(e.queue_entry_id);
					if (e.run_id) runIds.add(e.run_id);
				}
			}
		}
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
		// …and back from the shared entry or run to every request deduplicated onto it, through that
		// request's own immutable receipt — so a duplicate stays reachable even if its event was lost.
		for (const id of [...queueEntryIds, ...runIds]) {
			const d = await env.DB.prepare("SELECT request_id FROM loop_start_receipts WHERE user_id = ?1 AND instance_id = ?2 AND json_extract(response_json, '$.duplicate_of') = ?3").bind(userId, instanceId, id).all<{ request_id: string }>();
			for (const row of d.results ?? []) requestIds.add(row.request_id);
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
