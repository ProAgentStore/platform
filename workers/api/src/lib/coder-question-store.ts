/**
 * Durable coder questions (#1025): what a parked coding run asked, and every state it went through.
 *
 * Every transition is a compare-and-swap on `state` that appends one line to `history`, so two
 * writers racing (the minute sweep deciding while a person answers) cannot both win, and the row is
 * its own audit trail. A HUMAN answer is accepted from every open state — it wins at any point.
 */
import type { Env } from "../types.js";
import { clipMarked } from "./clip-marked.js";
import { redactText } from "./local-browser/contract.js";
import { codingQuestionIssueUrl } from "./coding-question-source.js";

export type CoderQuestionState = "waiting_human" | "brain_deciding" | "answered_human" | "answered_brain" | "escalated" | "unresolved" | "expired";
export type AnswerVia = "console" | "mcp" | "brain";
export const OPEN_QUESTION_STATES: readonly CoderQuestionState[] = ["waiting_human", "brain_deciding", "escalated"];

export interface CoderQuestion {
	id: string;
	instanceId: string;
	userId: string;
	sessionId: string;
	runId: string | null;
	taskId: string | null;
	repo: string | null;
	issueNumber: number | null;
	/** Canonical source link, derived from the bound repo and issue rather than question text. */
	issueUrl?: string;
	question: string;
	options: string[];
	why: string | null;
	state: CoderQuestionState;
	askedAt: number;
	expiresAt: number;
	escalatedAt: number | null;
	resolvedAt: number | null;
	answeredBy: "human" | "brain" | null;
	decision: string | null;
	confidence: number | null;
	reason: string | null;
	model: string | null;
	promptHash: string | null;
	/** #1026: the source labels the brain cited, and the risks it named — on a decision, and on a decline when given. */
	evidence: string[];
	risks: string[];
	/** #1075: the door the answer came through, when it was recorded, and when (and by which run) it was consumed. */
	answeredVia: AnswerVia | null;
	answeredAt: number | null;
	appliedAt: number | null;
	appliedRunId: string | null;
	history: Array<{ at: number; from: CoderQuestionState | null; to: CoderQuestionState; note: string }>;
}

type Row = Record<string, unknown>;
const json = <T>(v: unknown, fallback: T): T => {
	try {
		return v ? (JSON.parse(String(v)) as T) : fallback;
	} catch {
		return fallback;
	}
};
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function asQuestion(r: Row): CoderQuestion {
	return {
		id: String(r.id),
		instanceId: String(r.instance_id),
		userId: String(r.user_id),
		sessionId: String(r.session_id),
		runId: r.run_id ? String(r.run_id) : null,
		taskId: r.task_id ? String(r.task_id) : null,
		repo: r.repo ? String(r.repo) : null,
		issueNumber: num(r.issue_number),
		...(codingQuestionIssueUrl(r.repo, num(r.issue_number)) ? { issueUrl: codingQuestionIssueUrl(r.repo, num(r.issue_number)) as string } : {}),
		question: String(r.question),
		options: json<string[]>(r.options, []),
		why: r.why ? String(r.why) : null,
		state: r.state as CoderQuestionState,
		askedAt: Number(r.asked_at),
		expiresAt: Number(r.expires_at),
		escalatedAt: num(r.escalated_at),
		resolvedAt: num(r.resolved_at),
		answeredBy: (r.answered_by as CoderQuestion["answeredBy"]) ?? null,
		decision: r.decision ? String(r.decision) : null,
		confidence: num(r.confidence),
		reason: r.reason ? String(r.reason) : null,
		model: r.model ? String(r.model) : null,
		promptHash: r.prompt_hash ? String(r.prompt_hash) : null,
		evidence: json<string[]>(r.evidence, []),
		risks: json<string[]>(r.risks, []),
		answeredVia: (r.answered_via as AnswerVia | null) ?? null,
		answeredAt: num(r.answered_at),
		appliedAt: num(r.applied_at),
		appliedRunId: r.applied_run_id ? String(r.applied_run_id) : null,
		history: json(r.history, []),
	};
}

export interface CaptureInput {
	instanceId: string;
	userId: string;
	sessionId: string;
	runId?: string | null;
	taskId?: string | null;
	question: string;
	options: string[];
	why?: string | null;
	/** When the run stops waiting, ms: the brain-off 15 minutes, or both timeouts plus a margin. */
	waitMs: number;
	now?: number;
}

/**
 * Record a question. Idempotent per (session, task, question) while it is open: a Workflow replay of
 * the ask returns the row it already wrote rather than a second question.
 */
export async function captureCoderQuestion(env: Pick<Env, "DB">, input: CaptureInput): Promise<CoderQuestion> {
	const open = await env.DB.prepare(
		`SELECT * FROM coder_questions WHERE session_id = ?1 AND COALESCE(task_id, '') = ?2 AND question = ?3 AND state IN ('waiting_human','brain_deciding','escalated') ORDER BY asked_at DESC LIMIT 1`,
	)
		.bind(input.sessionId, input.taskId ?? "", input.question)
		.first<Row>();
	if (open) return asQuestion(open);
	const now = input.now ?? Date.now();
	// Repo and issue are read off the session (or its ticket) — where the question is answered in the open.
	const where = await env.DB.prepare(
		`SELECT r.github_repo AS repo, COALESCE(s.issue_number, t.issue_number) AS issue
		   FROM coding_sessions s
		   LEFT JOIN coding_repos r ON r.id = s.repo_id
		   LEFT JOIN agent_loop_runs l ON l.run_id = ?2
		   LEFT JOIN tickets t ON t.id = l.ticket_id
		  WHERE s.id = ?1`,
	)
		.bind(input.sessionId, input.runId ?? "")
		.first<{ repo: string | null; issue: number | null }>()
		.catch(() => null);
	const id = crypto.randomUUID();
	const history = [{ at: now, from: null, to: "waiting_human", note: "asked; the owner was notified" }];
	await env.DB.prepare(
		`INSERT INTO coder_questions (id, instance_id, user_id, session_id, run_id, task_id, repo, issue_number, question, options, why, state, asked_at, expires_at, history)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'waiting_human', ?12, ?13, ?14)`,
	)
		.bind(id, input.instanceId, input.userId, input.sessionId, input.runId ?? null, input.taskId ?? null, where?.repo ?? null, where?.issue ?? null, input.question, JSON.stringify(input.options), input.why ?? null, now, now + input.waitMs, JSON.stringify(history))
		.run();
	return (await getCoderQuestion(env, id)) as CoderQuestion;
}

export async function getCoderQuestion(env: Pick<Env, "DB">, id: string): Promise<CoderQuestion | null> {
	const r = await env.DB.prepare("SELECT * FROM coder_questions WHERE id = ?1").bind(id).first<Row>();
	return r ? asQuestion(r) : null;
}

export async function listCoderQuestions(env: Pick<Env, "DB">, instanceId: string, userId: string, opts: { state?: CoderQuestionState; limit?: number } = {}): Promise<CoderQuestion[]> {
	const { results } = await env.DB.prepare(
		`SELECT * FROM coder_questions WHERE instance_id = ?1 AND user_id = ?2 AND (?3 IS NULL OR state = ?3) ORDER BY asked_at DESC, rowid DESC LIMIT ?4`,
	)
		.bind(instanceId, userId, opts.state ?? null, Math.min(Math.max(opts.limit ?? 20, 1), 100))
		.all<Row>();
	return (results ?? []).map(asQuestion);
}

/** Open questions due for the sweep's attention, oldest first. */
export async function openCoderQuestions(env: Pick<Env, "DB">, limit = 25): Promise<CoderQuestion[]> {
	const { results } = await env.DB.prepare("SELECT * FROM coder_questions WHERE state IN ('waiting_human','brain_deciding','escalated') ORDER BY asked_at ASC LIMIT ?1").bind(limit).all<Row>();
	return (results ?? []).map(asQuestion);
}

/**
 * Move a question from one of `from` to `to`, recording why. False when another writer moved it
 * first — the caller must then do nothing it would have done on success.
 */
export async function transitionCoderQuestion(
	env: Pick<Env, "DB">,
	id: string,
	from: readonly CoderQuestionState[],
	to: CoderQuestionState,
	note: string,
	fields: Partial<{ escalatedAt: number; resolvedAt: number; answeredBy: "human" | "brain"; answeredVia: AnswerVia; answeredAt: number; decision: string; confidence: number; reason: string; model: string; promptHash: string; evidence: string[]; risks: string[] }> = {},
	now = Date.now(),
): Promise<boolean> {
	const placeholders = from.map((_, i) => `?${i + 16}`).join(", ");
	const res = await env.DB.prepare(
		`UPDATE coder_questions SET state = ?2,
		        escalated_at = COALESCE(?3, escalated_at), resolved_at = COALESCE(?4, resolved_at), answered_by = COALESCE(?5, answered_by),
		        decision = COALESCE(?6, decision), confidence = COALESCE(?7, confidence), reason = COALESCE(?8, reason),
		        model = COALESCE(?9, model), prompt_hash = COALESCE(?10, prompt_hash),
		        evidence = COALESCE(?12, evidence), risks = COALESCE(?13, risks),
		        answered_via = COALESCE(?14, answered_via), answered_at = COALESCE(?15, answered_at),
		        history = json_insert(history, '$[#]', json(?11))
		  WHERE id = ?1 AND state IN (${placeholders})`,
	)
		.bind(
			id,
			to,
			fields.escalatedAt ?? null,
			fields.resolvedAt ?? null,
			fields.answeredBy ?? null,
			fields.decision ?? null,
			fields.confidence ?? null,
			fields.reason ?? null,
			fields.model ?? null,
			fields.promptHash ?? null,
			JSON.stringify({ at: now, from: from.length === 1 ? from[0] : null, to, note }),
			fields.evidence ? JSON.stringify(fields.evidence) : null,
			fields.risks ? JSON.stringify(fields.risks) : null,
			fields.answeredVia ?? null,
			fields.answeredAt ?? null,
			...from,
		)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

/**
 * A person's answer as the row keeps it: credential-shaped text redacted and clipped (#1026), since
 * these routes also carry values like a 2FA code. Undefined for an empty answer (a bare "done").
 */
export function answerForRecord(answer: string | undefined): string | undefined {
	const t = answer?.trim();
	return t ? clipMarked(redactText(t), 300, { within: true }) : undefined;
}

export interface RecordAnswerInput {
	instanceId: string;
	userId: string;
	/** The card the question was asked on — what `/input` and `answer_instance_input` carry. */
	taskId?: string | null;
	/** The session, for the takeover route, which knows no card: matches only a question still open. */
	sessionId?: string | null;
	value: string | undefined;
	via: Exclude<AnswerVia, "brain">;
	now?: number;
}

/**
 * What `recordAnswer` did with the answer.
 *   answered         → an open question (or one the brain answered and no run has used yet) now holds it
 *   revised          → the owner replaced their own earlier answer before any run used it
 *   already_answered → byte-identical to the answer already on the row; nothing was written again (#1256)
 *   late             → the question had expired; the answer is kept on it for the resume / next run
 *   already_applied  → a run already consumed an earlier answer; this one is recorded in the history only
 */
export type RecordedOutcome = "answered" | "revised" | "already_answered" | "late" | "already_applied";

/**
 * #1075: the ONE writer of a person's answer. Every door (`POST /input`, MCP `answer_instance_input`,
 * the takeover route) calls this FIRST, before it tries to deliver anything to a live run — the row is
 * the source of truth, the runner push is only a way to wake a live engine sooner.
 *
 * Accepts the answer in ANY state of the card's question: open, expired, after its run ended, after the
 * brain decided. Null only when there is no question to record it on — a card with none, or an empty
 * answer to a question that is not open (nothing to keep). A person wins until a run has CONSUMED an
 * answer (`applied_at`); after that a second answer is recorded in the history and reported as
 * `already_applied`, never silently dropped and never rewriting what the run acted on.
 */
export async function recordAnswer(env: Pick<Env, "DB">, input: RecordAnswerInput): Promise<{ question: CoderQuestion; outcome: RecordedOutcome } | null> {
	const now = input.now ?? Date.now();
	const decision = answerForRecord(input.value);
	const open = OPEN_QUESTION_STATES.map((s) => `'${s}'`).join(",");
	// A compare-and-swap that loses to a concurrent writer (the sweep expiring it, the brain deciding)
	// re-reads and tries again against the state that won.
	for (let attempt = 0; attempt < 3; attempt++) {
		const row = await env.DB.prepare(
			`SELECT * FROM coder_questions WHERE instance_id = ?1 AND user_id = ?2
			    AND (CASE WHEN ?3 IS NOT NULL THEN task_id = ?3 ELSE session_id = ?4 AND state IN (${open}) END)
			  ORDER BY state IN (${open}) DESC, asked_at DESC, rowid DESC LIMIT 1`,
		)
			.bind(input.instanceId, input.userId, input.taskId ?? null, input.sessionId ?? "")
			.first<Row>();
		if (!row) return null;
		const q = asQuestion(row);
		const isOpen = OPEN_QUESTION_STATES.includes(q.state);
		if (!decision && !isOpen) return null;
		const fields = { answeredBy: "human" as const, answeredVia: input.via, answeredAt: now, resolvedAt: now, ...(decision ? { decision } : {}) };
		let outcome: RecordedOutcome;
		let moved: boolean;
		if (q.appliedAt) {
			outcome = "already_applied";
			moved = await transitionCoderQuestion(env, q.id, [q.state], q.state, `answered again via ${input.via} after run ${q.appliedRunId ?? "?"} used the earlier answer; recorded, not applied: ${decision}`, {}, now);
		} else if (isOpen) {
			outcome = "answered";
			moved = await transitionCoderQuestion(env, q.id, OPEN_QUESTION_STATES, "answered_human", `answered by a person (${input.via})`, fields, now);
		} else if (q.state === "expired") {
			outcome = "late";
			moved = await transitionCoderQuestion(env, q.id, ["expired"], "expired", `answered by a person (${input.via}) after the run stopped waiting`, fields, now);
		} else if (q.state === "answered_human") {
			// #1256: a byte-identical resubmission — a client retry after a timeout, a double-click on
			// submit — is not a revision. Reported plainly, and nothing is written again: a second write
			// of the same value would only add history noise for something that did not change.
			if ((decision ?? null) === (q.decision ?? null)) return { question: q, outcome: "already_answered" };
			outcome = "revised";
			moved = await transitionCoderQuestion(env, q.id, ["answered_human"], "answered_human", `answer revised by a person (${input.via}) before any run used it`, fields, now);
		} else {
			// answered_brain / unresolved, not yet consumed: the person's answer wins (#1025).
			outcome = "answered";
			moved = await transitionCoderQuestion(env, q.id, [q.state], "answered_human", `answered by a person (${input.via}) before any run used the ${q.state === "answered_brain" ? "brain's decision" : "unresolved instruction"}`, fields, now);
		}
		if (moved) return { question: (await getCoderQuestion(env, q.id)) as CoderQuestion, outcome };
	}
	return null;
}

/**
 * What the coder is told when nobody answered and the brain declined (#1025 §4): finish what does not
 * depend on the decision, and close the issue with what is left. Composed from the row, so the minute
 * sweep's delivery and a parked run's read of the row (#1076) say the same thing.
 */
export function unresolvedInstruction(q: Pick<CoderQuestion, "question" | "reason" | "options" | "issueNumber">): string {
	const issueRef = q.issueNumber ? `issue #${q.issueNumber}` : "the issue";
	return [
		`UNRESOLVED DECISION — nobody answered "${q.question}" and the coder brain declined (${q.reason ?? "no reason recorded"}).`,
		"Do NOT decide it yourself. Finish everything that does not depend on this decision, run the checks, and commit straight to main (no branches, no pull requests).",
		`Then close ${issueRef} with a comment containing: the question; the options${q.options.length ? ` (${q.options.join(", ")})` : ""}; why the brain declined; what was done (the commit SHAs); what is left; and the exact decision needed to finish.`,
	].join(" ");
}

/**
 * #1075: the answer a parked run should resume with, read from the ROW — so it survives a runner
 * restart, and (#1076) reaches a run waiting at zero compute. A person's answer (any state, even
 * recorded after `expired`), the brain's decision, or its unresolved instruction, as long as no run
 * has consumed it yet. Null when there is nothing to apply.
 */
export async function storedAnswer(env: Pick<Env, "DB">, questionId: string): Promise<{ value?: string; by: "human" | "brain" } | null> {
	const r = await env.DB.prepare("SELECT * FROM coder_questions WHERE id = ?1").bind(questionId).first<Row>();
	if (!r || r.applied_at != null) return null;
	const q = asQuestion(r);
	if (q.answeredAt != null && q.answeredBy === "human") return { value: q.decision ?? undefined, by: "human" };
	if (q.answeredAt != null && q.state === "answered_brain" && q.decision) return { value: `Decided by the coder brain: ${q.decision}. Reason: ${q.reason ?? "none recorded"}`, by: "brain" };
	if (q.state === "unresolved") return { value: unresolvedInstruction(q), by: "brain" };
	return null;
}

/** A run consumed the question's answer. Once: a replay or a second consumer leaves the first record. */
export async function markAnswerApplied(env: Pick<Env, "DB">, questionId: string, runId: string | null, now = Date.now()): Promise<boolean> {
	const res = await env.DB.prepare(
		`UPDATE coder_questions SET applied_at = ?2, applied_run_id = ?3, history = json_insert(history, '$[#]', json_object('at', ?2, 'from', state, 'to', state, 'note', ?4))
		  WHERE id = ?1 AND applied_at IS NULL`,
	)
		.bind(questionId, now, runId, `answer applied by run ${runId ?? "(no run id)"}`)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}
