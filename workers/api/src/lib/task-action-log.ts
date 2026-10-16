/**
 * One ordered action log per board card, for every task type (#1108).
 *
 * ── Where it lives, and why not a new table
 *
 * A card is a row of `instance_runtime_tasks`, and its per-card event stream already exists:
 * `instance_runtime_task_events`, keyed by `task_id`, never pruned, rendered by the run-detail page
 * and read by the ticket thread (#150). So an action is one more row there, of type `action`, with
 * a common payload — nothing new to retain, own or delete (the instance cascade already covers it).
 *
 * The detailed traces stay where they are (`agent_events`, `coding_timeline`, the Tailor/Runner run
 * traces, the Scout's run events). This log is the card's paper trail: one line per step that
 * matters — started, committed, submitted, blocked, finished — each with the links it produced.
 *
 * The runner's own task events (a browser task's `task.created` / `task.completed` / its steps)
 * already sit in the same table under the same card, so they are NOT copied: {@link readActionLog}
 * projects them into the same shape on read (type, message and time only — never the raw payload),
 * which is how a browser task's log needs no second writer.
 *
 * ── Redaction, before persistence
 *
 * Every artifact URL is reduced to origin + path by `traceUrl` (#1069) — no query, no fragment, no
 * credentials — and every URL inside a summary is reduced the same way, both on write and on read
 * (a projected runner message was written by somebody else).
 *
 * ── Order and paging
 *
 * `created_at` has one-second resolution, so the order is `(created_at, id)`, and an action's id
 * leads with its millisecond time so two actions in the same second keep their order. The walk is
 * OLDEST first — a paper trail reads forwards — over the `#1090` cursor encoding; the last row's
 * cursor is always returned (`tail`), so a live view polls from it and receives only what is new.
 *
 * TODO(#1104): grouping a card's log with the logs of every other task on the same WORK SUBJECT (one
 * GitHub issue's several coding runs, one job ad's several applications) is deferred — the subject
 * model is an open owner design decision. The log is keyed on the card, which exists today.
 */
import { clipMarked } from "./clip-marked.js";
import { encodeHistoryCursor, parseHistoryCursor } from "./history-page.js";
import { traceUrl } from "./local-browser/contract.js";
import { sqlTime } from "./sql-time.js";
import { TICKET_ANSWER_EVENT, TICKET_QUESTION_EVENT } from "./ticket-chat.js";
import type { Env } from "../types.js";

export const ACTION_EVENT_TYPE = "action";

export const ACTION_STATUSES = ["running", "ok", "error", "skipped"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export interface ActionArtifact {
	label: string;
	url: string;
}

/** One entry of a card's log — the common shape every task type writes and every reader gets. */
export interface ActionEntry {
	id: string;
	/** ISO time. */
	ts: string;
	/** Who acted: `coding-engine`, `tailor`, `runner`, `browser-agent`, `owner`, `platform`, … */
	actor: string;
	/** The instance that acted. */
	instanceId: string;
	/** `checkpoint` | `tool_call` | `commit` | `navigate` | `submit` | `blocker` | `outcome` | … */
	actionType: string;
	summary: string;
	status: ActionStatus;
	artifacts: ActionArtifact[];
	/** `action` for a written entry; the runner's own event type for one projected on read. */
	source: string;
}

export interface ActionInput {
	instanceId: string;
	userId: string;
	/** The card's id (`instance_runtime_tasks.id`). */
	taskId: string;
	actor: string;
	actionType: string;
	summary: string;
	status: ActionStatus;
	artifacts?: ActionArtifact[];
	/** ms epoch; defaults to now. */
	at?: number;
	/**
	 * Makes the write idempotent: a second write with the same key for the same card records
	 * nothing. For a write that a workflow replay or a repeated sync can repeat.
	 */
	dedupeKey?: string;
}

const MAX_SUMMARY = 500;
const MAX_ARTIFACTS = 10;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>)\]]+/g;

/** Every URL in a line of text reduced to origin + path (#1069). */
export function redactUrlsInText(text: string): string {
	return text.replace(URL_IN_TEXT, (url) => traceUrl(url) || "[url removed]");
}

/** Artifacts with redacted URLs; one whose URL is not http(s) is dropped, never kept raw. */
export function redactArtifacts(artifacts: readonly ActionArtifact[] | undefined): ActionArtifact[] {
	const out: ActionArtifact[] = [];
	for (const a of artifacts ?? []) {
		const url = traceUrl(String(a?.url ?? ""));
		if (!url) continue;
		out.push({ label: clipMarked(redactUrlsInText(String(a.label ?? "")), 120) || url, url });
		if (out.length >= MAX_ARTIFACTS) break;
	}
	return out;
}

let writeSeq = 0;

/** Write one action to the card's log. Best-effort: a log line must never fail the work it records. */
export async function writeActionEntry(env: Pick<Env, "DB">, input: ActionInput): Promise<void> {
	if (!input.taskId || !input.instanceId || !input.userId) return;
	const at = input.at ?? Date.now();
	// Time, then this isolate's write sequence: two actions in the same millisecond keep their order.
	const id = `act-${String(at).padStart(13, "0")}-${String(++writeSeq % 1e9).padStart(9, "0")}-${crypto.randomUUID()}`;
	const summary = clipMarked(redactUrlsInText(input.summary), MAX_SUMMARY);
	const payload = {
		id,
		taskId: input.taskId,
		type: ACTION_EVENT_TYPE,
		// `message` too, so every existing reader of this table (run detail, instance feed) shows a line.
		message: summary,
		actor: input.actor,
		instanceId: input.instanceId,
		actionType: input.actionType,
		summary,
		status: input.status,
		artifacts: redactArtifacts(input.artifacts),
		ts: new Date(at).toISOString(),
		...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
	};
	try {
		await env.DB.prepare(
			`INSERT INTO instance_runtime_task_events (id, instance_id, user_id, task_id, type, payload, created_at)
			 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
			 WHERE ?8 IS NULL OR NOT EXISTS (
			   SELECT 1 FROM instance_runtime_task_events
			    WHERE user_id = ?3 AND task_id = ?4 AND type = ?5 AND json_extract(payload, '$.dedupeKey') = ?8)`,
		)
			.bind(id, input.instanceId, input.userId, input.taskId, ACTION_EVENT_TYPE, JSON.stringify(payload), sqlTime(at), input.dedupeKey ?? null)
			.run();
	} catch {
		/* the record of the work, never the work */
	}
}

type Row = { id: string; instance_id: string; type: string; payload: string; created_at: string };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const isoOf = (sql: string) => (sql.includes("T") ? sql : `${sql.replace(" ", "T")}Z`);

/** A runner/platform event projected into the common shape: its type, its message, its time. Never its raw payload. */
function projectRuntimeEvent(row: Row, ev: Record<string, unknown>): ActionEntry {
	const type = row.type;
	const status: ActionStatus = type === "task.failed" ? "error" : type === "task.cancelled" ? "skipped" : type === "task.created" ? "running" : "ok";
	const actionType =
		type === "task.created"
			? "checkpoint"
			: type === "task.completed" || type === "task.failed" || type === "task.cancelled"
				? "outcome"
				: type === "agent.needs_input" || type === "job.human_handoff_required"
					? "blocker"
					: type.startsWith("browser.") || type.includes("navigat")
						? "navigate"
						: "step";
	const url = traceUrl(str(ev.url));
	return {
		id: row.id,
		ts: str(ev.createdAt) || isoOf(row.created_at),
		actor: "browser-agent",
		instanceId: row.instance_id,
		actionType,
		summary: clipMarked(redactUrlsInText(str(ev.message) || type), MAX_SUMMARY),
		status: actionType === "blocker" ? "running" : status,
		artifacts: url ? [{ label: "page", url }] : [],
		source: type,
	};
}

function toEntry(row: Row): ActionEntry | null {
	let ev: Record<string, unknown>;
	try {
		ev = JSON.parse(row.payload) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (row.type !== ACTION_EVENT_TYPE) return projectRuntimeEvent(row, ev);
	const status = ACTION_STATUSES.includes(ev.status as ActionStatus) ? (ev.status as ActionStatus) : "ok";
	return {
		id: row.id,
		ts: str(ev.ts) || isoOf(row.created_at),
		actor: str(ev.actor) || "agent",
		instanceId: str(ev.instanceId) || row.instance_id,
		actionType: str(ev.actionType) || "step",
		// Redacted again on read: a row written before a rule tightened is reduced when it is shown.
		summary: redactUrlsInText(str(ev.summary)),
		status,
		artifacts: redactArtifacts(Array.isArray(ev.artifacts) ? (ev.artifacts as ActionArtifact[]) : []),
		source: ACTION_EVENT_TYPE,
	};
}

export const ACTION_LOG_MAX_LIMIT = 50;
export const ACTION_LOG_DEFAULT_LIMIT = 20;

export interface ActionLogPage {
	taskId: string;
	entries: ActionEntry[];
	/** More rows exist after this page: pass `nextCursor`. */
	hasMore: boolean;
	nextCursor: string | null;
	/** The last row read — poll from it for new entries while the task runs. Null on an empty log. */
	tail: string | null;
	/** Every row of this card's log, so a short page is never read as the whole history. */
	total: number;
}

export type ActionLogResult = ActionLogPage | { error: "not_found" | "bad_cursor" };

/**
 * One page of a card's log, oldest first. Owner-scoped: the card must be this user's, on this
 * instance; the rows are read by user and card, so an application card whose home moved between
 * the Tailor and the Runner keeps every entry written under either.
 */
export async function readActionLog(
	env: Pick<Env, "DB">,
	q: { instanceId: string; userId: string; taskId: string; cursor?: string | null; limit?: number },
): Promise<ActionLogResult> {
	const card = await env.DB.prepare("SELECT id FROM instance_runtime_tasks WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
		.bind(q.taskId, q.instanceId, q.userId)
		.first<{ id: string }>();
	if (!card) return { error: "not_found" };
	const cursor = parseHistoryCursor(q.cursor ?? "", "string");
	if (cursor.kind === "invalid") return { error: "bad_cursor" };
	const limit = Math.min(Math.max(Math.trunc(Number(q.limit) || ACTION_LOG_DEFAULT_LIMIT), 1), ACTION_LOG_MAX_LIMIT);
	const where = ["user_id = ?1", "task_id = ?2", "type NOT IN (?3, ?4)"];
	const binds: unknown[] = [q.userId, q.taskId, TICKET_QUESTION_EVENT, TICKET_ANSWER_EVENT];
	if (cursor.kind === "after") {
		binds.push(cursor.key, cursor.id);
		where.push(`(created_at > ?${binds.length - 1} OR (created_at = ?${binds.length - 1} AND id > ?${binds.length}))`);
	}
	const { results } = await env.DB.prepare(
		`SELECT id, instance_id, type, payload, created_at FROM instance_runtime_task_events WHERE ${where.join(" AND ")} ORDER BY created_at ASC, id ASC LIMIT ${limit + 1}`,
	)
		.bind(...binds)
		.all<Row>();
	const rows = results ?? [];
	const page = rows.slice(0, limit);
	const hasMore = rows.length > limit;
	const last = page[page.length - 1];
	const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM instance_runtime_task_events WHERE user_id = ?1 AND task_id = ?2 AND type NOT IN (?3, ?4)")
		.bind(q.userId, q.taskId, TICKET_QUESTION_EVENT, TICKET_ANSWER_EVENT)
		.first<{ n: number }>();
	const tail = last ? encodeHistoryCursor(last.created_at, last.id) : cursor.kind === "after" ? (q.cursor ?? null) : null;
	return {
		taskId: q.taskId,
		entries: page.map(toEntry).filter((e): e is ActionEntry => e !== null),
		hasMore,
		nextCursor: hasMore ? tail : null,
		tail,
		total: Number(total?.n ?? 0),
	};
}
