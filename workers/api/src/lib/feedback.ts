/**
 * In-session feedback (D1 `agent_feedback`, migration 0122) — what the OWNER said was wrong,
 * anchored to the turn it is about (#514).
 *
 * ## What this is FOR, and the boundary that keeps it from becoming a second memory system
 *
 * Feedback is the class where the PLATFORM is at fault and no configuration fixes it: a wrong
 * answer, an action the agent claimed but did not take, a step that failed silently. It is
 * evidence for a ticket, and it is never read back as instruction. Three other destinations
 * already exist and none of them is this one — "be less technical" is BEHAVIOUR, "always check CI
 * before saying it deployed" is Rules & Tips, "the admin app is the one with the version gate" is
 * MEMORY. Blurring that line is how this repo twice paid for a preference stored as a fact (#226)
 * and a stale fact steering a live agent (#495).
 *
 * Nothing here is ever injected into a system prompt. `agent-think.ts` does not import this
 * module, and `agent-think.prompt.test.ts` asserts that it stays that way.
 *
 * ## Why the row carries both pointers and snapshots
 *
 * The pointers (`trace_id`, `message_id`, `session_id`, `timeline_seq`) are what make a complaint
 * as good as the hand-correlation that produced #503–#505: one `agent_trace(trace_id=…)` call and
 * the tool calls of the complained-about turn are on screen. But every referent is deletable —
 * clearing the chat removes the messages and their R2 audio, and the trace prunes at 14 days — so
 * the snapshot fields hold the evidence itself. Neither kind is sufficient; see migration 0122.
 *
 * The build/validate half is PURE and is where the decisions live (what a valid body is, what gets
 * clamped, which enums are closed). The D1 half below is wiring.
 */
import type { Env } from "../types.js";

/** Who wrote the row: the console affordance, or the agent's own `record_feedback` tool. */
export type FeedbackAuthor = "user" | "agent";
export type FeedbackSurface = "chat" | "coding" | "board" | "apply" | "other";
export type FeedbackSentiment = "bad" | "good";
export type FeedbackStatus = "open" | "triaged" | "filed" | "dismissed";

const AUTHORS: readonly FeedbackAuthor[] = ["user", "agent"];
const SURFACES: readonly FeedbackSurface[] = ["chat", "coding", "board", "apply", "other"];
const SENTIMENTS: readonly FeedbackSentiment[] = ["bad", "good"];
export const FEEDBACK_STATUSES: readonly FeedbackStatus[] = ["open", "triaged", "filed", "dismissed"];

/**
 * Caps. Generous, because a complaint the owner bothered to type is cheap to store and expensive
 * to lose — but bounded, because `target_text` is a message the agent wrote and an agent can write
 * a lot. The prompt snapshot is the smallest: #505 needed only the sentence before, to prove a
 * third turn did not exist.
 */
export const FEEDBACK_LIMITS = { body: 4000, targetText: 2000, promptText: 1000, context: 4000, issueUrl: 500 } as const;

export interface FeedbackInput {
	userId: string;
	instanceId: string;
	body: string;
	author?: string;
	surface?: string;
	sentiment?: string | null;
	traceId?: string | null;
	messageId?: string | null;
	sessionId?: string | null;
	timelineSeq?: number | null;
	targetRole?: string | null;
	targetText?: string | null;
	targetAt?: string | null;
	promptText?: string | null;
	context?: Record<string, unknown> | null;
	/** ms epoch. Defaults to now. */
	ts?: number;
}

export interface FeedbackRow {
	id: string;
	ts: number;
	created_at: string;
	user_id: string;
	instance_id: string;
	author: FeedbackAuthor;
	surface: FeedbackSurface;
	sentiment: FeedbackSentiment | null;
	body: string;
	trace_id: string | null;
	message_id: string | null;
	session_id: string | null;
	timeline_seq: number | null;
	target_role: string | null;
	target_text: string | null;
	target_at: string | null;
	prompt_text: string | null;
	context: string | null;
	status: FeedbackStatus;
	issue_url: string | null;
	updated_at: string;
}

/** What `buildFeedbackRow` produces: a row ready to insert, or the reason it refused. */
export type FeedbackBuild = { ok: true; row: NewFeedbackRow } | { ok: false; error: string };

/** The insert shape — `created_at`/`updated_at` are the table's own defaults. */
export type NewFeedbackRow = Omit<FeedbackRow, "created_at" | "updated_at">;

const clamp = (v: unknown, max: number): string | null => {
	if (typeof v !== "string") return null;
	const t = v.trim();
	return t ? t.slice(0, max) : null;
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
	typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

/**
 * Validate and clamp one capture into the row that will be stored. Pure.
 *
 * Every enum is CLOSED and falls back rather than refusing: a caller that invents a surface gets
 * `other` and the complaint is still kept. The one thing that CAN refuse is an empty body — a
 * feedback row with nothing said is not evidence, and #514's whole premise is that a bare
 * thumbs-down is not filable.
 */
export function buildFeedbackRow(input: FeedbackInput, now = Date.now()): FeedbackBuild {
	const body = clamp(input.body, FEEDBACK_LIMITS.body);
	if (!body) return { ok: false, error: "body required" };
	if (!input.userId || !input.instanceId) return { ok: false, error: "instance required" };
	const seq = typeof input.timelineSeq === "number" && Number.isFinite(input.timelineSeq) ? Math.trunc(input.timelineSeq) : null;
	// Serialised HERE rather than at the call site so the cap is applied to the JSON that is
	// actually stored. A context blob that overflows is truncated to null, never to invalid JSON:
	// half a JSON object read back by the console is worse than no context at all.
	let context: string | null = null;
	if (input.context && typeof input.context === "object") {
		const json = JSON.stringify(input.context);
		context = json.length <= FEEDBACK_LIMITS.context ? json : null;
	}
	return {
		ok: true,
		row: {
			id: crypto.randomUUID(),
			ts: typeof input.ts === "number" && Number.isFinite(input.ts) ? Math.trunc(input.ts) : now,
			user_id: input.userId,
			instance_id: input.instanceId,
			author: oneOf(input.author, AUTHORS, "user"),
			surface: oneOf(input.surface, SURFACES, "chat"),
			sentiment: typeof input.sentiment === "string" && (SENTIMENTS as readonly string[]).includes(input.sentiment)
				? (input.sentiment as FeedbackSentiment)
				: null,
			body,
			trace_id: clamp(input.traceId, 200),
			message_id: clamp(input.messageId, 200),
			session_id: clamp(input.sessionId, 200),
			timeline_seq: seq,
			target_role: clamp(input.targetRole, 24),
			target_text: clamp(input.targetText, FEEDBACK_LIMITS.targetText),
			target_at: clamp(input.targetAt, 64),
			prompt_text: clamp(input.promptText, FEEDBACK_LIMITS.promptText),
			context,
			status: "open",
			issue_url: null,
		},
	};
}

const COLUMNS =
	"id, ts, created_at, user_id, instance_id, author, surface, sentiment, body, trace_id, message_id, session_id, timeline_seq, target_role, target_text, target_at, prompt_text, context, status, issue_url, updated_at";

/** Persist a built row. Unlike logError/logEvent this DOES throw: a capture the owner performed
 *  deliberately must not fail silently — the whole complaint is the payload. */
export async function insertFeedback(env: Env, row: NewFeedbackRow): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO agent_feedback (id, ts, user_id, instance_id, author, surface, sentiment, body,
		  trace_id, message_id, session_id, timeline_seq, target_role, target_text, target_at,
		  prompt_text, context, status, issue_url)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`,
	)
		.bind(
			row.id,
			row.ts,
			row.user_id,
			row.instance_id,
			row.author,
			row.surface,
			row.sentiment,
			row.body,
			row.trace_id,
			row.message_id,
			row.session_id,
			row.timeline_seq,
			row.target_role,
			row.target_text,
			row.target_at,
			row.prompt_text,
			row.context,
			row.status,
			row.issue_url,
		)
		.run();
}

export interface FeedbackPage {
	rows: FeedbackRow[];
	/** Real total matching the filters — NOT the page length. Always accurate. */
	total: number;
	/** True when there are rows beyond the current page. */
	hasMore: boolean;
}

/**
 * One owner's feedback, newest first. Always user-scoped — there is no `scope=all`.
 *
 * Pagination: `limit` rows per page (default 50, max 500), `offset` skips rows.
 * A `limit + 1` probe answers `hasMore` without a second query; the extra row is dropped.
 * A separate `COUNT(*)` returns the real total so callers can show it honestly.
 */
export async function listFeedback(
	env: Env,
	opts: { userId: string; instanceId?: string; status?: FeedbackStatus; limit?: number; offset?: number },
): Promise<FeedbackPage> {
	const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
	const offset = Math.max(0, opts.offset ?? 0);
	const binds: unknown[] = [opts.userId];
	const where = ["user_id = ?1"];
	if (opts.instanceId) {
		binds.push(opts.instanceId);
		where.push(`instance_id = ?${binds.length}`);
	}
	if (opts.status) {
		binds.push(opts.status);
		where.push(`status = ?${binds.length}`);
	}
	const whereClause = where.join(" AND ");
	// Probe one extra row to answer hasMore without a second query.
	const [pageRes, countRes] = await Promise.all([
		env.DB.prepare(
			`SELECT ${COLUMNS} FROM agent_feedback WHERE ${whereClause} ORDER BY ts DESC LIMIT ${limit + 1} OFFSET ${offset}`,
		)
			.bind(...binds)
			.all<FeedbackRow>(),
		env.DB.prepare(`SELECT COUNT(*) AS n FROM agent_feedback WHERE ${whereClause}`)
			.bind(...binds)
			.first<{ n: number }>(),
	]);
	const all = pageRes.results ?? [];
	const hasMore = all.length > limit;
	return { rows: hasMore ? all.slice(0, limit) : all, total: countRes?.n ?? 0, hasMore };
}

/**
 * Move a row through triage. The BODY is deliberately not settable: a feedback row records what
 * the owner said at a moment, and editing that destroys the one property that makes it evidence —
 * #505 is specifically about a record that did not match what was said. Only `status` and
 * `issue_url` move, and `updated_at` with them.
 *
 * Returns false when the id is not this user's, so the route can 404 without a second SELECT.
 */
export async function updateFeedback(
	env: Env,
	opts: { id: string; userId: string; status?: FeedbackStatus; issueUrl?: string | null },
): Promise<boolean> {
	const sets: string[] = ["updated_at = datetime('now')"];
	const binds: unknown[] = [];
	if (opts.status) {
		binds.push(opts.status);
		sets.push(`status = ?${binds.length}`);
	}
	if (opts.issueUrl !== undefined) {
		binds.push(opts.issueUrl ? String(opts.issueUrl).slice(0, FEEDBACK_LIMITS.issueUrl) : null);
		sets.push(`issue_url = ?${binds.length}`);
	}
	binds.push(opts.id, opts.userId);
	const res = await env.DB.prepare(
		`UPDATE agent_feedback SET ${sets.join(", ")} WHERE id = ?${binds.length - 1} AND user_id = ?${binds.length}`,
	)
		.bind(...binds)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

/**
 * Hard delete, owner-scoped. It survives Clear chat by design and can contain anything the owner
 * typed — including PII or a pasted secret — so "delete my data" has to reach it.
 */
export async function deleteFeedback(env: Env, opts: { id: string; userId: string }): Promise<boolean> {
	const res = await env.DB.prepare("DELETE FROM agent_feedback WHERE id = ?1 AND user_id = ?2")
		.bind(opts.id, opts.userId)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}
