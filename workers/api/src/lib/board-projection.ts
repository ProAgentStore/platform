/**
 * The shared, owner-scoped card projection of actual execution (#1698): one card per resumable coding session or real
 * application / scan attempt, plus every accepted objective that has no session yet, each classified into the SAME four lanes by
 * ONE pure function, so the per-instance board and an All Agents view cannot classify differently.
 *
 * IDENTITY comes from `board-identity.ts` and is never a job URL, a GitHub issue or an applicant. A GitHub issue is not read here at
 * all: issue labels and linked Project state are display metadata and take no part in a card's identity, lane or status.
 *
 * LANES (the owner's, #1698): `queued`, `in_progress`, `blocked`, `done`.
 *   - Waiting a turn, or awaiting first session creation, is QUEUED, never blocked.
 *   - Only an actual blocker is BLOCKED, and the card says what blocks it and who owns the next action.
 *   - NEEDS YOU is a badge (`needsYou`), not a lane, and uses the same rules as the owner inbox (#1640) for a parked run and a
 *     coder question, so the two cannot disagree.
 *   - WAITING TO RESUME is a recorded answer the run has not applied yet (`ANSWER_PENDING_SQL`, the inbox's own definition): it is
 *     waiting on the RUN, so it is queued, `nextOwner: "run"`, and `needsYou` is false. It is never a renewed owner action.
 *   - A terminal outcome (`succeeded` | `failed` | `stopped`) is its own field, separate from the Done lane.
 *
 * QUEUE HANDOFF. An accepted objective is a card from `pending` through the drain's `running` claim (the window the old queue read
 * left empty) until a real session exists. Once its run has a session, the session card owns the work and the objective card is
 * dropped in the same read, so there is never a duplicate and never a gap. An entry that started a run with no session (a non-coding
 * run) stays visible, classified from that run. Scheduling and queue semantics are untouched: this only reads.
 *
 * NATIVE STATE is kept: `nativeStatus`, the run's `waitingReason`, and the ids a deep link needs are on every card.
 *
 * Not here (#1697 owns it): New / Discussed / Deferred triage of questions. `needsYou` is only "is this waiting on the owner".
 */
import type { Env } from "../types.js";
import { type BoardCardIdentity, type BoardIdentityRecord, cardIdentityForRecord } from "./board-identity.js";
import { ANSWER_PENDING_SQL } from "./coder-question-store.js";

export const BOARD_LANE_IDS = ["queued", "in_progress", "blocked", "done"] as const;
export type BoardLaneId = (typeof BOARD_LANE_IDS)[number];
export const BOARD_LANE_TITLES: Record<BoardLaneId, string> = { queued: "Queued", in_progress: "In Progress", blocked: "Blocked", done: "Done" };

export type BoardOutcome = "succeeded" | "failed" | "stopped";
/** Who acts next: the owner, the run itself (it resumes or starts), or the platform (a limit resets, a machine reconnects). */
export type NextOwner = "owner" | "run" | "platform";

export interface CardBlocker {
	what: string;
	nextOwner: NextOwner;
}

/** What the classifier needs about one card, and nothing else. */
export interface CardFacts {
	kind: BoardIdentityRecord["kind"];
	/** The record's own status (run, session, entry). */
	status: string;
	/** The run's park reason, for a coding run. */
	waitingReason?: string | null;
	/** An open coder question (`waiting_human` / `escalated`) belongs to this run. */
	openQuestion?: boolean;
	/** An answer is recorded and the run has not applied it (`ANSWER_PENDING_SQL`). */
	answerPending?: boolean;
	/** A queued objective whose run exists: the run's status, which classifies it. */
	runStatus?: string | null;
	/** The question text, for the blocker line. */
	question?: string | null;
}

export interface CardClassification {
	lane: BoardLaneId;
	needsYou: boolean;
	waitingToResume: boolean;
	blocker?: CardBlocker;
	outcome?: BoardOutcome;
}

const done = (outcome: BoardOutcome): CardClassification => ({ lane: "done", needsYou: false, waitingToResume: false, outcome });
const queued = (extra: Partial<CardClassification> = {}): CardClassification => ({ lane: "queued", needsYou: false, waitingToResume: false, ...extra });
const progress = (): CardClassification => ({ lane: "in_progress", needsYou: false, waitingToResume: false });
const blockedOnOwner = (what: string): CardClassification => ({ lane: "blocked", needsYou: true, waitingToResume: false, blocker: { what, nextOwner: "owner" } });
const blockedOn = (what: string, nextOwner: NextOwner): CardClassification => ({ lane: "blocked", needsYou: false, waitingToResume: false, blocker: { what, nextOwner } });

/** A parked coding run, by why it is parked. The owner-waiting reasons match the inbox's `run_parked` rule. */
function parkedRun(f: CardFacts): CardClassification {
	switch (f.waitingReason) {
		case "decision":
			// An open question is the question's row; a recorded answer is waiting on the RUN (#1678).
			if (f.openQuestion) return blockedOnOwner(f.question?.trim() ? `Waiting for your answer: ${f.question.trim()}` : "Waiting for your answer");
			if (f.answerPending) return queued({ waitingToResume: true, blocker: undefined });
			return blockedOnOwner("Waiting for your decision");
		case "human":
			return blockedOnOwner("Waiting for you");
		case "engine_auth":
			return blockedOnOwner("The coding CLI needs you to sign in");
		case "engine_limit":
			return blockedOn("Waiting for the engine's usage limit to reset", "platform");
		case "runner_away":
			return blockedOn("Its runner machine is away", "platform");
		case "platform_interrupt":
			return queued(); // waiting a turn: the platform paused it and will resume it
		default:
			return progress();
	}
}

function fromRunStatus(status: string, f: CardFacts): CardClassification {
	switch (status) {
		case "running":
			return f.waitingReason ? parkedRun(f) : progress();
		case "needs_human":
			return blockedOnOwner("Waiting for you");
		case "completed":
			return done("succeeded");
		case "failed":
			return done("failed");
		case "cancelled":
			return done("stopped");
		case "queued":
		case "pending":
			return queued();
		default:
			return progress();
	}
}

/**
 * The lane, badge, blocker and outcome for one card. Pure: one function for every board, so classification is identical in the
 * per-instance and All Agents views.
 */
export function classifyCard(f: CardFacts): CardClassification {
	switch (f.kind) {
		case "queued-objective": {
			// pending: waiting its turn. running: claimed by a drain and being started: awaiting its first session. Both are Queued.
			if (f.status === "pending" || f.status === "running") return queued();
			if (f.status === "failed") return done("failed");
			if (f.status === "cancelled") return done("stopped");
			// started: a run exists; classify from it, and fall back to in progress when the run is not known.
			return f.runStatus ? fromRunStatus(f.runStatus, f) : progress();
		}
		case "coding-session": {
			// The newest run decides while there is one; a session with no run is a created, active session.
			if (f.runStatus) return fromRunStatus(f.runStatus, f);
			if (f.status === "ended") return done("stopped");
			if (f.status === "error") return done("failed");
			return progress();
		}
		case "application-attempt":
		case "scan":
			switch (f.status) {
				case "queued":
					return queued();
				case "running":
					return progress();
				case "paused":
				case "awaiting_review":
				case "needs_human":
					return blockedOnOwner(f.status === "awaiting_review" ? "Waiting for your review" : "Waiting for you");
				case "blocked":
					return blockedOn("The attempt could not continue", "owner");
				case "submitted":
				case "completed":
					return done("succeeded");
				case "failed":
					return done("failed");
				case "cancelled":
					return done("stopped");
				default:
					return progress();
			}
	}
}

export interface ProjectedCard extends BoardCardIdentity, CardClassification {
	/** Native detail a deep link and a detail view need; every field is the record's own. */
	native: {
		status: string;
		waitingReason?: string | null;
		runId?: string | null;
		sessionId?: string | null;
		runKind?: "fill" | "tailor";
		applicationId?: string;
		queueEntryId?: string | null;
	};
	title: string;
	/** ms epoch of the newest change, for ordering. */
	updatedAt: number;
}

const LIMIT = 500;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const clip = (s: string, n = 140): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

type Row = Record<string, unknown>;

/**
 * Every card of this owner's instance. Owner- AND instance-scoped in every query (`instance_id = ?1 AND user_id = ?2`); a caller
 * that does not own the instance gets nothing, never another tenant's cards. Newest first.
 */
export async function readBoardProjection(env: Env, instanceId: string, userId: string): Promise<ProjectedCard[]> {
	const q = async (sql: string): Promise<Row[]> => {
		const r = await env.DB.prepare(sql).bind(instanceId, userId).all<Row>().catch(() => ({ results: [] as Row[] }));
		return r.results ?? [];
	};
	const [sessions, runs, questions, applyRuns, tailorRuns, scans, queue] = await Promise.all([
		q(`SELECT id, status, started_at, updated_at, issue_title FROM coding_sessions WHERE instance_id = ?1 AND user_id = ?2 ORDER BY started_at DESC LIMIT ${LIMIT}`),
		q(`SELECT run_id, session_id, queue_entry_id, objective, status, waiting_reason, started_at, finished_at FROM agent_loop_runs WHERE instance_id = ?1 AND user_id = ?2 AND (session_id IS NOT NULL OR queue_entry_id IS NOT NULL) ORDER BY started_at DESC LIMIT ${LIMIT}`),
		q(`SELECT q.run_id, q.session_id, q.question, q.state, (${ANSWER_PENDING_SQL}) AS answer_pending FROM coder_questions q WHERE q.instance_id = ?1 AND q.user_id = ?2 AND (q.state IN ('waiting_human', 'escalated') OR (${ANSWER_PENDING_SQL})) ORDER BY q.asked_at DESC LIMIT ${LIMIT}`),
		q(`SELECT id, application_id, status, created_at, started_at, ended_at, updated_at FROM local_apply_runs WHERE instance_id = ?1 AND user_id = ?2 ORDER BY created_at DESC LIMIT ${LIMIT}`),
		q(`SELECT id, application_id, status, created_at, started_at, ended_at, updated_at FROM local_artifact_runs WHERE instance_id = ?1 AND user_id = ?2 ORDER BY created_at DESC LIMIT ${LIMIT}`),
		q(`SELECT id, objective, status, created_at, updated_at FROM local_browser_runs WHERE instance_id = ?1 AND user_id = ?2 ORDER BY created_at DESC LIMIT ${LIMIT}`),
		q(`SELECT id, objective, status, run_id, created_at, started_at, finished_at FROM instance_objective_queue WHERE instance_id = ?1 AND user_id = ?2 AND status IN ('pending', 'running', 'started', 'failed') ORDER BY created_at DESC LIMIT ${LIMIT}`),
	]);
	const scope = { instanceId, userId };
	const cards: ProjectedCard[] = [];

	// The newest run behind each session (rows arrive newest first), and each run's session.
	const newestRun = new Map<string, Row>();
	const runById = new Map<string, Row>();
	const sessionOfRun = new Map<string, string>();
	const sessionOfEntry = new Map<string, string>();
	for (const r of runs) {
		const sid = str(r.session_id);
		runById.set(str(r.run_id), r);
		// A run with no session (a non-coding run) has no session card; it only classifies the queue entry that started it.
		if (sid && !newestRun.has(sid)) newestRun.set(sid, r);
		if (sid) sessionOfRun.set(str(r.run_id), sid);
		if (sid && str(r.queue_entry_id) && !sessionOfEntry.has(str(r.queue_entry_id))) sessionOfEntry.set(str(r.queue_entry_id), sid);
	}
	const openByRun = new Map<string, Row>();
	const pendingByRun = new Set<string>();
	for (const r of questions) {
		const run = str(r.run_id);
		if (!run) continue;
		if (num(r.answer_pending) === 1 && r.state !== "waiting_human" && r.state !== "escalated") pendingByRun.add(run);
		else if (!openByRun.has(run)) openByRun.set(run, r);
	}

	const push = (record: BoardIdentityRecord, f: CardFacts, native: ProjectedCard["native"], title: string, at: number) => {
		const identity = cardIdentityForRecord(record, scope);
		cards.push({ ...identity, ...classifyCard(f), native, title, updatedAt: at });
	};

	for (const s of sessions) {
		const sid = str(s.id);
		const run = newestRun.get(sid);
		const runId = run ? str(run.run_id) : "";
		const facts: CardFacts = {
			kind: "coding-session",
			status: str(s.status),
			waitingReason: run ? str(run.waiting_reason) || null : null,
			runStatus: run ? str(run.status) : null,
			openQuestion: !!runId && openByRun.has(runId),
			answerPending: !!runId && pendingByRun.has(runId),
			question: runId ? str(openByRun.get(runId)?.question) : null,
		};
		push(
			{ kind: "coding-session", instanceId, userId, sessionId: sid, status: str(s.status), runIds: runs.filter((r) => str(r.session_id) === sid).map((r) => str(r.run_id)) },
			facts,
			{ status: str(s.status), waitingReason: facts.waitingReason, runId: runId || null, sessionId: sid },
			clip(str(run?.objective) || str(s.issue_title) || "Coding session"),
			num(run?.finished_at) || num(run?.started_at) || Date.parse(`${str(s.updated_at)}Z`) || 0,
		);
	}

	for (const [rows, runKind] of [[applyRuns, "fill"], [tailorRuns, "tailor"]] as const) {
		for (const r of rows) {
			push(
				{ kind: "application-attempt", instanceId, userId, applicationId: str(r.application_id), runKind, runId: str(r.id), status: str(r.status) },
				{ kind: "application-attempt", status: str(r.status) },
				{ status: str(r.status), runId: str(r.id), runKind, applicationId: str(r.application_id) },
				runKind === "fill" ? "Application attempt" : "Tailor attempt",
				num(r.ended_at) || num(r.updated_at) || num(r.created_at),
			);
		}
	}

	for (const r of scans) {
		push(
			{ kind: "scan", instanceId, userId, runId: str(r.id), status: str(r.status) },
			{ kind: "scan", status: str(r.status) },
			{ status: str(r.status), runId: str(r.id) },
			clip(str(r.objective) || "Scan"),
			num(r.updated_at) || num(r.created_at),
		);
	}

	// A queued objective is a card until a real session exists; then the session card owns the work (no duplicate, no gap).
	for (const e of queue) {
		const entryId = str(e.id);
		const runId = str(e.run_id);
		const sessionId = (runId && sessionOfRun.get(runId)) || sessionOfEntry.get(entryId) || "";
		if (str(e.status) === "started" && sessionId) continue;
		const run = runId ? runById.get(runId) : undefined;
		push(
			{ kind: "queued-objective", instanceId, userId, entryId, status: str(e.status), runId: runId || null, sessionId: sessionId || null },
			{ kind: "queued-objective", status: str(e.status), runStatus: run ? str(run.status) : null },
			{ status: str(e.status), runId: runId || null, queueEntryId: entryId, sessionId: sessionId || null },
			clip(str(e.objective).split("\n", 1)[0] || "Queued objective"),
			num(e.finished_at) || num(e.started_at) || num(e.created_at),
		);
	}

	return cards.sort((a, b) => b.updatedAt - a.updatedAt || a.cardId.localeCompare(b.cardId));
}

/** Cards grouped into the four lanes, in lane order. The same grouping serves every board. */
export function groupIntoLanes<T extends { lane: BoardLaneId }>(cards: readonly T[]): Record<BoardLaneId, T[]> {
	const out: Record<BoardLaneId, T[]> = { queued: [], in_progress: [], blocked: [], done: [] };
	for (const c of cards) out[c.lane].push(c);
	return out;
}
