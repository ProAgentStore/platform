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

export type CoderQuestionState = "waiting_human" | "brain_deciding" | "answered_human" | "answered_brain" | "escalated" | "unresolved" | "expired";
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
	fields: Partial<{ escalatedAt: number; resolvedAt: number; answeredBy: "human" | "brain"; decision: string; confidence: number; reason: string; model: string; promptHash: string; evidence: string[]; risks: string[] }> = {},
	now = Date.now(),
): Promise<boolean> {
	const placeholders = from.map((_, i) => `?${i + 14}`).join(", ");
	const res = await env.DB.prepare(
		`UPDATE coder_questions SET state = ?2,
		        escalated_at = COALESCE(?3, escalated_at), resolved_at = COALESCE(?4, resolved_at), answered_by = COALESCE(?5, answered_by),
		        decision = COALESCE(?6, decision), confidence = COALESCE(?7, confidence), reason = COALESCE(?8, reason),
		        model = COALESCE(?9, model), prompt_hash = COALESCE(?10, prompt_hash),
		        evidence = COALESCE(?12, evidence), risks = COALESCE(?13, risks),
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
			...from,
		)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

/**
 * A person answered the question waiting on this session. Wins from every open state — including
 * `brain_deciding`, whose in-flight decision is then discarded by its own failed swap.
 */
/**
 * A person answered. `answer` (#1026) is recorded as the decision, so the brain's later grounding sees what the owner
 * chose before — credential-shaped text redacted and clipped, since these routes also carry values like a 2FA code.
 */
export async function markHumanAnswered(env: Pick<Env, "DB">, instanceId: string, sessionId: string, now = Date.now(), answer?: string): Promise<string | null> {
	const open = await env.DB.prepare("SELECT id FROM coder_questions WHERE instance_id = ?1 AND session_id = ?2 AND state IN ('waiting_human','brain_deciding','escalated') ORDER BY asked_at DESC LIMIT 1")
		.bind(instanceId, sessionId)
		.first<{ id: string }>();
	if (!open) return null;
	const decision = answer?.trim() ? clipMarked(redactText(answer.trim()), 300, { within: true }) : undefined;
	const moved = await transitionCoderQuestion(env, open.id, OPEN_QUESTION_STATES, "answered_human", "answered by a person", { answeredBy: "human", resolvedAt: now, ...(decision ? { decision } : {}) }, now);
	return moved ? open.id : null;
}
