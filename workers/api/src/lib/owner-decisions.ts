/**
 * Durable owner decisions for the agent types beyond the coder (#1079, epic #1072 §E).
 *
 * The coder's contract (#1075, `coder-question-store.ts`) is: every pause is a decision row on its
 * subject; an answer is ALWAYS stored there first, whatever became of the run; a resume — or the next
 * run on the same subject — reads it; and the row records which run consumed it. This is that
 * contract for JOB_APPLY and the Application Runner. Before it, a JOB_APPLY answer that arrived after
 * the 15-minute window was refused ("That takeover session is gone") with nothing recorded, and a
 * Runner answer was "for that run only, never stored": an ended run refused it outright.
 *
 * The decision outlives everything around it: the run's live window, the runner's memory, and the
 * browser takeover (#1031) — a takeover expiring ends the takeover row, never this one.
 */
import type { Env } from "../types.js";

export type DecisionKind = "job_apply" | "apply_run";
export type DecisionVia = "console" | "mcp";

/** Answers are form values; the Runner already refuses longer ones, and nothing here cuts one. */
export const MAX_DECISION_ANSWER_CHARS = 2_000;

export interface OwnerDecision {
	id: string;
	instanceId: string;
	userId: string;
	kind: DecisionKind;
	subjectId: string;
	taskId: string | null;
	scope: string | null;
	field: string | null;
	question: string;
	answer: string | null;
	answeredVia: DecisionVia | null;
	askedAt: number;
	answeredAt: number | null;
	appliedAt: number | null;
	appliedRef: string | null;
	history: Array<{ at: number; note: string }>;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
function asDecision(r: Row): OwnerDecision {
	let history: OwnerDecision["history"] = [];
	try {
		history = JSON.parse(String(r.history ?? "[]"));
	} catch {
		history = []; // a malformed audit trail is not a reason to lose the decision it describes
	}
	return {
		id: String(r.id),
		instanceId: String(r.instance_id),
		userId: String(r.user_id),
		kind: r.subject_kind as DecisionKind,
		subjectId: String(r.subject_id),
		taskId: r.task_id ? String(r.task_id) : null,
		scope: r.scope ? String(r.scope) : null,
		field: r.field ? String(r.field) : null,
		question: String(r.question),
		answer: r.answer === null || r.answer === undefined ? null : String(r.answer),
		answeredVia: (r.answered_via as DecisionVia | null) ?? null,
		askedAt: Number(r.asked_at),
		answeredAt: num(r.answered_at),
		appliedAt: num(r.applied_at),
		appliedRef: r.applied_ref ? String(r.applied_ref) : null,
		history,
	};
}

const historyEntry = (at: number, note: string) => JSON.stringify({ at, note });

export async function getDecision(env: Pick<Env, "DB">, id: string): Promise<OwnerDecision | null> {
	const r = await env.DB.prepare("SELECT * FROM owner_decisions WHERE id = ?1").bind(id).first<Row>();
	return r ? asDecision(r) : null;
}

/**
 * Record the question a run paused on. Idempotent per (card, question) while unanswered, so a
 * workflow replay or a repeated sync returns the row it already wrote.
 */
export async function recordPauseDecision(
	env: Pick<Env, "DB">,
	input: { instanceId: string; userId: string; kind: DecisionKind; subjectId: string; taskId: string | null; scope: string | null; field?: string | null; question: string; now?: number },
): Promise<OwnerDecision> {
	const open = await env.DB.prepare("SELECT * FROM owner_decisions WHERE instance_id = ?1 AND user_id = ?2 AND COALESCE(task_id, '') = ?3 AND question = ?4 AND answered_at IS NULL ORDER BY asked_at DESC LIMIT 1")
		.bind(input.instanceId, input.userId, input.taskId ?? "", input.question)
		.first<Row>();
	if (open) return asDecision(open);
	const now = input.now ?? Date.now();
	const id = crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO owner_decisions (id, instance_id, user_id, subject_kind, subject_id, task_id, scope, field, question, asked_at, history)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, json_array(json(?11)))`,
	)
		.bind(id, input.instanceId, input.userId, input.kind, input.subjectId, input.taskId, input.scope, input.field ?? null, input.question, now, historyEntry(now, "asked; the run paused on it"))
		.run();
	return (await getDecision(env, id)) as OwnerDecision;
}

export type DecisionOutcome = "answered" | "revised" | "already_applied";

/**
 * Store an owner's answer FIRST, before anything tries to deliver it. Finds the card's latest
 * decision — any state — or, given `question`, the decision with that question on the card (creating
 * it when the run never recorded one: an answer is never dropped for want of a row). A decision a
 * run already consumed keeps what the run acted on; the new answer is recorded in its history only.
 * Null when the card has no decision and no question was given, or the answer is empty.
 */
export async function answerDecision(
	env: Pick<Env, "DB">,
	input: { instanceId: string; userId: string; taskId: string; value: string; via: DecisionVia; question?: string; create?: { kind: DecisionKind; subjectId: string; scope: string | null }; now?: number },
): Promise<{ decision: OwnerDecision; outcome: DecisionOutcome } | null> {
	const value = input.value.trim();
	if (!value || value.length > MAX_DECISION_ANSWER_CHARS) return null;
	const now = input.now ?? Date.now();
	let row = await env.DB.prepare(
		`SELECT * FROM owner_decisions WHERE instance_id = ?1 AND user_id = ?2 AND task_id = ?3 AND (?4 IS NULL OR question = ?4)
		  ORDER BY (answered_at IS NULL) DESC, asked_at DESC, rowid DESC LIMIT 1`,
	)
		.bind(input.instanceId, input.userId, input.taskId, input.question ?? null)
		.first<Row>();
	if (!row && input.question && input.create) {
		const created = await recordPauseDecision(env, { instanceId: input.instanceId, userId: input.userId, kind: input.create.kind, subjectId: input.create.subjectId, taskId: input.taskId, scope: input.create.scope, question: input.question, now });
		row = await env.DB.prepare("SELECT * FROM owner_decisions WHERE id = ?1").bind(created.id).first<Row>();
	}
	if (!row) return null;
	const d = asDecision(row);
	if (d.appliedAt) {
		await env.DB.prepare("UPDATE owner_decisions SET history = json_insert(history, '$[#]', json(?2)) WHERE id = ?1")
			.bind(d.id, historyEntry(now, `answered again via ${input.via} after ${d.appliedRef ?? "a run"} used the earlier answer; recorded, not applied: ${value}`))
			.run();
		return { decision: (await getDecision(env, d.id)) as OwnerDecision, outcome: "already_applied" };
	}
	const outcome: DecisionOutcome = d.answeredAt ? "revised" : "answered";
	await env.DB.prepare(
		"UPDATE owner_decisions SET answer = ?2, answered_via = ?3, answered_at = ?4, history = json_insert(history, '$[#]', json(?5)) WHERE id = ?1 AND applied_at IS NULL",
	)
		.bind(d.id, value, input.via, now, historyEntry(now, outcome === "revised" ? `answer revised (${input.via}) before any run used it` : `answered (${input.via})`))
		.run();
	return { decision: (await getDecision(env, d.id)) as OwnerDecision, outcome };
}

/** Answered decisions no run has used yet, for the next run on this subject — oldest first, one per question (the latest answer wins). */
export async function pendingAnswersFor(env: Pick<Env, "DB">, input: { instanceId: string; userId: string; kind: DecisionKind; scope: string }): Promise<OwnerDecision[]> {
	const { results } = await env.DB.prepare(
		`SELECT * FROM owner_decisions WHERE instance_id = ?1 AND user_id = ?2 AND subject_kind = ?3 AND scope = ?4 AND answered_at IS NOT NULL AND applied_at IS NULL
		  ORDER BY answered_at ASC, rowid ASC`,
	)
		.bind(input.instanceId, input.userId, input.kind, input.scope)
		.all<Row>();
	const latest = new Map<string, OwnerDecision>();
	for (const r of results ?? []) {
		const d = asDecision(r);
		latest.set(d.field ?? d.question, d);
	}
	return [...latest.values()];
}

/** Record that a run consumed these decisions. Once: a decision already applied keeps its first consumer. */
export async function markDecisionsApplied(env: Pick<Env, "DB">, ids: readonly string[], ref: string, now = Date.now()): Promise<void> {
	for (const id of ids) {
		await env.DB.prepare("UPDATE owner_decisions SET applied_at = ?2, applied_ref = ?3, history = json_insert(history, '$[#]', json(?4)) WHERE id = ?1 AND applied_at IS NULL")
			.bind(id, now, ref, historyEntry(now, `applied by ${ref}`))
			.run();
	}
}

/** Mark the decisions on a card applied — the in-window path, where the live run consumed the answer itself. */
export async function markCardApplied(env: Pick<Env, "DB">, instanceId: string, taskId: string, ref: string, now = Date.now()): Promise<void> {
	const { results } = await env.DB.prepare("SELECT id FROM owner_decisions WHERE instance_id = ?1 AND task_id = ?2 AND answered_at IS NOT NULL AND applied_at IS NULL").bind(instanceId, taskId).all<{ id: string }>();
	await markDecisionsApplied(env, (results ?? []).map((r) => r.id), ref, now);
}
