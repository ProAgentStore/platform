// A coding card, reconciled against the run and the session it is keyed on (#592).
//
// ── What `attempts` actually was, because the ticket asked for the writer and there isn't one
//
// `attempts` was never a counter and nothing ever incremented it. `buildInstanceBoard` groups the
// instance's `instance_runtime_tasks` by `jobKeyForTask` and reports `arr.length` — so `attempts`
// counts CARD ROWS sharing a job key, not runs. For an apply card that is the same number: each
// attempt inserts its own task row and they collapse on the normalized URL, which is what
// `board-config.test.ts` pins at 2.
//
// For a coding card it is pinned at 1 by construction, and correctly so at the layer that does it:
// `codingCardId` is `csess-<sessionId>` and `upsertWorkCard` is `ON CONFLICT(id) DO UPDATE`, so one
// session is one row forever — that dedup is the feature ("so every transition upserts the SAME row
// rather than piling up"). A coding session's attempts are its `agent_loop_runs`, which live in a
// different table and were never read. Measured on `csess_c960d431`: nine runs, one of them failed,
// reported as `attempts:1, completed`.
//
// So the fix is not a write. It is the read-time join `board.ts` never had — which is also the only
// form that can be right, because a session leaves `active` in five places (see `coding-board.ts`)
// and a write-through would have to be added to all five and kept there.
//
// ── Why the run outranks the card
//
// `coding-board.ts` already states the rule this module applies: "THE RUN'S verdict on its own
// card. Unconditional, because the run is the authority (#553)." A card is a projection of work,
// and the run is the only thing that knows how the work went. Where the stored card and the run
// disagree, the card is stale, not the run.
//
// PURE where it can be: `reconcileCodingCard` takes facts and returns a patch, so the invariant
// "a card agrees with the run and the session it is keyed on" is testable without D1.
import { cardDetail } from "./card-detail.js";
import type { Env } from "../types.js";

/** Card-id prefix for a coding session. Mirrors `codingCardId`; `board-runs.test.ts` pins them equal. */
const CODING_CARD_PREFIX = "csess-";

/** The runtime-task type a coding session writes. Mirrors `codingSessionTaskRecord`. */
export const CODING_SESSION_TASK_TYPE = "coding.session";

/** The session id a coding card is keyed on, or "" when the id is not a coding card. */
export function codingSessionIdFromCardId(cardId: string): string {
	return cardId.startsWith(CODING_CARD_PREFIX) ? cardId.slice(CODING_CARD_PREFIX.length) : "";
}

/** One `agent_loop_runs` row, reduced to what a card needs. */
export interface CodingRunFact {
	runId: string;
	status: string;
	detail: string;
	/** ms epoch — when it finished, else when it started. */
	at: number;
}

/** One `coding_sessions` row, reduced to what a card needs. */
export interface CodingSessionFact {
	/** `active` | `ended` | `error`. */
	status: string;
}

/** An attempt as the board reports it. Structurally `BoardAttempt`. */
export interface ReconciledAttempt {
	id: string;
	status: string;
	updatedAt: string;
}

export interface CodingCardInput {
	/** The card's stored status — what the run/session writers last wrote. */
	runStatus: string;
	/** The card's stored one-line detail. */
	description: string;
	/** The row-derived attempts, used when the session has no runs behind it. */
	attempts: readonly ReconciledAttempt[];
	/** Every loop run carrying this session id, any order. */
	runs: readonly CodingRunFact[];
	/** The session, when it still exists. */
	session?: CodingSessionFact;
}

export interface CodingCardPatch {
	runStatus: string;
	description: string;
	attempts: ReconciledAttempt[];
	/** True when the card is keyed on a session that is over. */
	sessionEnded: boolean;
}

/**
 * Run statuses a run is passing THROUGH rather than resting at.
 *
 * Same split `isCodingCardOpen` makes for the card, and for the same reason: `needs_human` is a run
 * parked mid-flight, not a verdict.
 */
const OPEN_RUN_STATUSES = new Set(["running", "needs_human"]);

/** Said when the session died under a card that was still asking for a human. */
const ABANDONED_LEAD = "The session ended while this was waiting for you — there is nothing left to take over.";

/**
 * Reconcile one coding card against its runs and its session.
 *
 * Three defects, one join (#592):
 *
 *  1. `attempts` becomes the RUNS behind the session rather than the single card row that
 *     represents it. A session with no loop runs — a human driving the engine by hand — keeps its
 *     row-derived attempt, because "one session, no automated runs" is the truth there.
 *
 *  2. A `needs_human` card whose session is over stops asking. It is only truthful while something
 *     can still answer it, and four of the five measured `needs_human` cards pointed at sessions
 *     that had ended minutes earlier. Where the run has since reached a verdict the card adopts it
 *     (the card is merely stale); where the run is ALSO still parked, nobody ever answered and the
 *     work is over, which is `failed` — never `completed`, which is the exact overwrite
 *     `closeCodingSessionCards`' `openOnly` guard exists to prevent.
 *
 *  3. The card carries the run's reason. All five measured `needs_human` cards had `detail: ""`
 *     while their run carried the full explanation; `setCodingSessionCardStatus` patches only the
 *     status, so the reason never reached the surface an owner reads.
 *
 * A human's own status move is NOT reconciled away — this returns `runStatus`, and `buildInstanceBoard`
 * still resolves `status = userStatus || runStatus` over it.
 */
export function reconcileCodingCard(input: CodingCardInput): CodingCardPatch {
	const runs = [...input.runs].sort((a, b) => b.at - a.at);
	const latest = runs[0];
	const sessionEnded = !!input.session && input.session.status !== "active";

	const attempts: ReconciledAttempt[] = runs.length
		? runs.map((r) => ({ id: r.runId, status: r.status, updatedAt: new Date(r.at).toISOString() }))
		: [...input.attempts];

	let runStatus = input.runStatus;
	let description = input.description;

	if (runStatus === "needs_human" && sessionEnded) {
		if (latest && !OPEN_RUN_STATUSES.has(latest.status)) {
			runStatus = latest.status;
		} else {
			runStatus = "failed";
			description = cardDetail(description || latest?.detail || "", ABANDONED_LEAD);
		}
	}

	// The run's reason, wherever the card has none of its own. Not an override: a card that already
	// carries a live progress line (`setWorkCardProgress`, #207B) keeps it.
	if (!description && latest?.detail) description = cardDetail(latest.detail);

	return { runStatus, description, attempts, sessionEnded };
}

interface LoopRunRow {
	run_id: string;
	session_id: string;
	status: string;
	detail: string | null;
	started_at: number;
	finished_at: number | null;
}

/**
 * Every loop run behind each of these sessions, grouped by session id.
 *
 * Tenant-scoped on `(instance_id, user_id)` like every other board read. `session_id` has no index
 * of its own (0116 says so, and says why: `check_work` looks runs up by `run_id`), so this rides
 * `idx_agent_loop_runs_instance` and filters — bounded by one instance's run history, which is the
 * same order of magnitude the board's own task read already scans.
 */
export async function codingRunsForSessions(
	env: Env,
	instanceId: string,
	userId: string,
	sessionIds: readonly string[],
): Promise<Map<string, CodingRunFact[]>> {
	const out = new Map<string, CodingRunFact[]>();
	if (!sessionIds.length) return out;
	const placeholders = sessionIds.map((_, i) => `?${i + 3}`).join(",");
	const rows = await env.DB.prepare(
		`SELECT run_id, session_id, status, detail, started_at, finished_at
		   FROM agent_loop_runs
		  WHERE instance_id = ?1 AND user_id = ?2 AND session_id IN (${placeholders})`,
	)
		.bind(instanceId, userId, ...sessionIds)
		.all<LoopRunRow>()
		.catch(() => ({ results: [] as LoopRunRow[] }));
	for (const r of rows.results ?? []) {
		if (!r.session_id) continue;
		const fact: CodingRunFact = {
			runId: String(r.run_id ?? ""),
			status: String(r.status ?? ""),
			detail: r.detail ?? "",
			at: Number(r.finished_at ?? r.started_at ?? 0) || 0,
		};
		const arr = out.get(r.session_id);
		if (arr) arr.push(fact);
		else out.set(r.session_id, [fact]);
	}
	return out;
}

/** The state of each of these sessions, by id. A session absent from the map no longer exists. */
export async function codingSessionStates(
	env: Env,
	instanceId: string,
	userId: string,
	sessionIds: readonly string[],
): Promise<Map<string, CodingSessionFact>> {
	const out = new Map<string, CodingSessionFact>();
	if (!sessionIds.length) return out;
	const placeholders = sessionIds.map((_, i) => `?${i + 3}`).join(",");
	const rows = await env.DB.prepare(
		`SELECT id, status FROM coding_sessions
		  WHERE instance_id = ?1 AND user_id = ?2 AND id IN (${placeholders})`,
	)
		.bind(instanceId, userId, ...sessionIds)
		.all<{ id: string; status: string }>()
		.catch(() => ({ results: [] as { id: string; status: string }[] }));
	for (const r of rows.results ?? []) out.set(String(r.id), { status: String(r.status ?? "") });
	return out;
}
