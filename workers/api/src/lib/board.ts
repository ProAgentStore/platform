import type { Env } from "../types.js";
import { mirroredRuntimeTasks, isRecord } from "../routes/instances-runtime.js";
import { agentCapabilities, sanitizeBoardColumns, type BoardColumn } from "./agent-capabilities.js";
import {
	CODING_SESSION_TASK_TYPE,
	codingRunsForSessions,
	codingSessionIdFromCardId,
	codingSessionStates,
	reconcileCodingCard,
} from "./board-runs.js";
import { patchInstanceConfig, removeInstanceConfigKey } from "./instance-config.js";
import { readIssue, type IssueSummary } from "./github-issues.js";
import { sqlLiteralList } from "./sql.js";
import { TICKET_ANSWER_EVENT, TICKET_QUESTION_EVENT } from "./ticket-chat.js";

/** How the board can be viewed in the console. Persisted per-instance so the choice
 *  follows the user across devices and is settable via UI, MCP, and the agent itself. */
export type BoardView = "kanban" | "list";

/** The resolved board configuration for one instance: which columns it shows, the
 *  preferred view, where the columns came from, and the agent's own default columns
 *  (so an editor can offer "reset to the agent's columns"). */
export interface BoardConfig {
	columns: BoardColumn[];
	view: BoardView;
	/** "instance" = a per-instance override is set; "agent" = the agent's declared/default columns. */
	source: "instance" | "agent";
	/** The agent-level columns, regardless of any instance override. */
	agentColumns: BoardColumn[];
}

function parseJson(value: unknown): Record<string, unknown> {
	if (typeof value !== "string" || !value) return {};
	try { const o = JSON.parse(value); return o && typeof o === "object" ? (o as Record<string, unknown>) : {}; }
	catch { return {}; }
}

/**
 * Resolve an instance's board columns + view. A per-instance override (stored in
 * `agent_instances.config.boardColumns` / `.boardView`) wins over the agent's declared
 * columns, which in turn fall back to the per-surface default. This single resolver is
 * shared by the board reader, the config route, MCP, and the agent tool so they can't drift.
 */
export async function boardConfigForInstance(env: Env, instanceId: string, userId: string): Promise<BoardConfig> {
	const row = await env.DB.prepare(
		`SELECT a.slug AS slug, a.category AS category, a.config AS agent_config, i.config AS instance_config
     FROM agent_instances i JOIN agents a ON a.id = i.agent_id
     WHERE i.id = ?1 AND i.user_id = ?2`,
	).bind(instanceId, userId).first<{ slug: string; category: string; agent_config: string; instance_config: string }>();

	const agentColumns = agentCapabilities({ slug: row?.slug, category: row?.category, config: row?.agent_config }).boardColumns;
	const instCfg = parseJson(row?.instance_config);
	const override = sanitizeBoardColumns(instCfg.boardColumns);
	const view: BoardView = instCfg.boardView === "list" ? "list" : "kanban";
	return {
		columns: override ?? agentColumns,
		view,
		source: override ? "instance" : "agent",
		agentColumns,
	};
}

/**
 * The single agent work board — the canonical builder shared by the console, the
 * MCP reader, and anything else. It groups the instance's runtime tasks into ONE
 * card per job, resolves the agent's configured columns, and applies the durable
 * `board_items` overlay (a human's status move). This is the ONE place the board
 * shape is defined, so the console and MCP can't drift.
 */

export interface BoardAttempt {
	id: string;
	status: string;
	updatedAt: string;
}

export interface BoardItemView {
	/** Stable per-job key (normalized URL, else the task id) — the move target. */
	jobKey: string;
	/** The newest attempt's task id — what the card opens by default. */
	latestTaskId: string;
	title: string;
	subtitle: string;
	description: string;
	/** Why the agent did this — the decision/audit for the ticket, shown in the card.
	 *  Carried in the runtime task's payload; absent for older/standalone cards. */
	reasoning?: string;
	url: string;
	/** The newest run's status. */
	runStatus: string;
	/**
	 * Turns in this ticket's conversation (#150) — the discoverability signal. Until this
	 * existed the thread was reachable only by opening a ticket, so nothing on the board said
	 * a card could be questioned, or that it already carried answers.
	 *
	 * Counted for `latestTaskId` ONLY, deliberately: that is the ticket the card opens, so the
	 * badge counts exactly the thread the user is about to see. Summing across every attempt
	 * would show "3" and then open an empty thread.
	 */
	threadTurns: number;
	/** A human status override (moved into a pipeline column), if any. */
	userStatus: string | null;
	/** Effective status = userStatus ?? runStatus — where the card lives. */
	status: string;
	attempts: BoardAttempt[];
	updatedAt: string;
	/**
	 * True when this card is keyed on a coding session that is OVER (#592).
	 *
	 * Set only where it is a fact worth acting on, so its absence never has to be read as "the
	 * session is fine". Four of five measured `needs_human` cards offered "take over" on sessions
	 * that had ended minutes earlier; a reader needs to be able to tell that the affordance is gone
	 * without inferring it from a status.
	 */
	sessionEnded?: boolean;
	/**
	 * Cached GitHub issue projection (#682). Present when the card is linked to a GitHub
	 * issue and a cached projection exists. Absent when not linked or not yet fetched.
	 * Read-only: the card's board column and the issue's labels are independent axes.
	 * Moving the card does not mutate the issue, and the labels come from GitHub, not
	 * the board.
	 */
	githubIssue?: GithubIssueProjection;
}

/** The cached GitHub issue fields a board card stores and displays (#682). */
export interface GithubIssueProjection {
	number: number;
	title: string;
	state: string;
	labels: string[];
	url: string;
}

export interface InstanceBoard {
	columns: BoardColumn[];
	items: BoardItemView[];
	/** The preferred view (kanban | list) — the console renders this by default. */
	view: BoardView;
	/** True when the runtime-task window was hit — older jobs may be missing. */
	truncated: boolean;
}

/** How many recent runtime tasks the board reads before grouping into jobs. */
const BOARD_TASK_LIMIT = 1000;

/**
 * The two conversation event types, as SQL LITERALS — the one place in this file that does
 * not bind a value, and deliberately so.
 *
 * SQLite only uses a partial index when it can PROVE the query's WHERE implies the index's
 * WHERE, and it does that by matching the predicate at prepare time. With `type IN (?3, ?4)`
 * the values are unknown then, so `idx_runtime_task_events_thread` (migration 0088) is
 * ignored and the count degrades to a full scan of the runtime event firehose — measurably:
 * `EXPLAIN QUERY PLAN` says SCAN for the bound form and SEARCH … USING INDEX for this one.
 * The board polls every 2.5s, so that is the difference between a cheap feature and an
 * expensive one, and it is invisible — the query returns the right answer either way.
 *
 * Safe because these are compile-time constants from ticket-chat.ts, never user input.
 * `sqlLiteralList` (#327) is where that stops being a claim in a comment: it rejects anything a
 * quote could escape out of, at module load, so the exception cannot quietly widen to a value
 * somebody later routes in from a request. `board.test.ts` additionally pins that this predicate
 * stays character-for-character identical to the migration's.
 */
export const TICKET_TURN_TYPES_SQL = sqlLiteralList([TICKET_QUESTION_EVENT, TICKET_ANSWER_EVENT]);

interface RawTask {
	id?: string;
	type?: string;
	status?: string;
	title?: string;
	subtitle?: string;
	description?: string;
	reasoning?: string;
	result?: string;
	input?: Record<string, unknown>;
	output?: Record<string, unknown>;
	createdAt?: string;
	updatedAt?: string;
}

/** Friendly names for the platform's own task types, so a card never shows a raw
 *  machine string like "job.apply_agent". */
const FRIENDLY_TYPES: Record<string, string> = {
	"job.apply_agent": "Job application",
	"setup.pags_browser_runtime": "Runner setup",
};

/** Title-case a machine type ("some_task.kind" → "Some Task Kind"). */
function prettifyType(type: string): string {
	return (
		FRIENDLY_TYPES[type] ||
		type.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim() ||
		"Task"
	);
}

// Generic route words that don't name the job — skipped when picking the title
// segment so e.g. Ashby /xero/<uuid>/application → "Xero", not "Application".
const GENERIC_PATH_SEGMENTS = new Set([
	"apply", "application", "applications", "job", "jobs", "career", "careers",
	"position", "positions", "opening", "openings", "listing", "listings",
	"vacancy", "vacancies", "role", "roles", "posting", "postings", "p", "en", "us",
]);

/** True for opaque id-ish path segments (UUID, long hex, or no letters at all). */
function isOpaqueSegment(seg: string): boolean {
	if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true; // UUID
	if (/^[0-9a-f]{12,}$/i.test(seg)) return true; // long hex blob
	if (!/[a-z]/i.test(seg)) return true; // pure numeric / hyphen / symbols
	return false;
}

/**
 * Derive a human card title + subtitle from a job URL. Walks the path from the end
 * and picks the segment that actually names the job/company — skipping opaque ids
 * (Dover /apply/<company>/<uuid>) and generic route words (…/jobs/<id>) that would
 * otherwise surface a UUID or "Jobs" as the card title.
 */
export function deriveFromUrl(url: string): { title: string; subtitle: string } {
	let host = "";
	let pathname = "";
	try { const u = new URL(url); host = u.hostname.replace(/^www\./, ""); pathname = u.pathname; }
	catch { return { title: "", subtitle: "" }; }
	const segs = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
	let slug = "";
	for (let i = segs.length - 1; i >= 0; i--) {
		const s = segs[i];
		if (isOpaqueSegment(s) || GENERIC_PATH_SEGMENTS.has(s.toLowerCase())) continue;
		slug = s;
		break;
	}
	const pretty = slug
		.replace(/-([a-z0-9]{4,8})$/i, (m, g: string) => (/\d/.test(g) ? "" : m))
		.replace(/[-_]+/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase())
		.trim();
	return { title: pretty || host, subtitle: pretty ? host : "" };
}

// Marketing/tracking query params that don't identify the job — dropped from the
// job key so two retries of the SAME job (differing only by tracking) collapse
// into one card. Everything else in the query is KEPT, because some ATS put the
// job identity in the query (LinkedIn currentJobId, Greenhouse gh_jid, …) and
// dropping it wholesale would merge DISTINCT jobs into one card.
const TRACKING_PARAMS = new Set([
	"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
	"source", "src", "ref", "referrer", "applysourceoverride", "gh_src",
	"trk", "trackingid", "recommendedflavor", "lipi", "originalsubdomain",
]);

/** A stable per-job key: the normalized job URL, else the task id (its own card). */
export function jobKeyForTask(task: RawTask): string {
	// Generic browser tasks recur at the SAME start URL (e.g. a periodic Facebook sweep),
	// so URL-keying would collapse every run into one ever-growing card. Key each run by
	// its task id → one card per run (a run history), not one card per URL.
	if (task.type === "browser.task") return String(task.id ?? "");
	const url = typeof task.input?.url === "string" ? task.input.url : "";
	if (url) {
		try {
			const u = new URL(url);
			// Keep identifying query params (sorted for stability); drop tracking noise.
			const kept = [...u.searchParams.entries()]
				.filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()))
				.map(([k, v]) => `${k.toLowerCase()}=${v}`)
				.sort();
			const path = `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
			return kept.length ? `${path}?${kept.join("&")}` : path;
		} catch { /* not a URL */ }
	}
	return String(task.id ?? "");
}

/**
 * A card label that is ALWAYS human-friendly and non-empty. Priority:
 *   1. the agent-set title/subtitle (the task-creation contract),
 *   2. derived from the job URL (company/role slug + host),
 *   3. a friendly-cased task type ("job.apply_agent" → "Job application").
 * A raw machine type or an empty title is never surfaced.
 */
function taskLabel(task: RawTask): { title: string; subtitle: string } {
	const agentTitle = typeof task.title === "string" ? task.title.trim() : "";
	const agentSubtitle = typeof task.subtitle === "string" ? task.subtitle.trim() : "";
	const url = typeof task.input?.url === "string" ? task.input.url : "";
	const derived = url ? deriveFromUrl(url) : { title: "", subtitle: "" };
	const title = agentTitle || derived.title || prettifyType(task.type || "");
	const subtitle = agentSubtitle || (agentTitle ? "" : derived.subtitle);
	return { title, subtitle };
}

/** A one-line description: the task's own, else the failure/outcome detail. */
function taskDescription(task: RawTask): string {
	if (task.description) return task.description;
	if (isRecord(task.output) && typeof task.output.detail === "string") return task.output.detail;
	if (typeof task.result === "string") return task.result;
	return "";
}

function stamp(task: RawTask): number {
	const n = Date.parse(task.updatedAt || task.createdAt || "");
	return Number.isNaN(n) ? 0 : n;
}

/** Resolve the effective board columns for an instance (per-instance override → agent
 *  declared → per-surface default). Thin wrapper over {@link boardConfigForInstance}. */
export async function columnsForInstance(env: Env, instanceId: string, userId: string): Promise<BoardColumn[]> {
	return (await boardConfigForInstance(env, instanceId, userId)).columns;
}

/** Parse a stored `github_issue_cache` blob into a projection, or null. */
function parseCachedIssue(raw: string | null | undefined): GithubIssueProjection | undefined {
	if (!raw) return undefined;
	try {
		const o = JSON.parse(raw) as unknown;
		if (!o || typeof o !== "object") return undefined;
		const r = o as Record<string, unknown>;
		if (typeof r.number !== "number" || typeof r.title !== "string" || typeof r.state !== "string") return undefined;
		return {
			number: r.number,
			title: r.title,
			state: r.state,
			labels: Array.isArray(r.labels) ? (r.labels as unknown[]).filter((l): l is string => typeof l === "string") : [],
			url: typeof r.url === "string" ? r.url : "",
		};
	} catch {
		return undefined;
	}
}

/** Serialize an IssueSummary into the compact JSON stored in `github_issue_cache`. */
function serializeIssueCache(issue: IssueSummary): string {
	return JSON.stringify({ number: issue.number, title: issue.title, state: issue.state, labels: issue.labels, url: issue.url });
}

/** Build the instance's single work board: configured columns + one card per job. */
export async function buildInstanceBoard(env: Env, instanceId: string, userId: string): Promise<InstanceBoard> {
	const [tasks, overlayRows, boardCfg, threadRows] = await Promise.all([
		mirroredRuntimeTasks(env, instanceId, userId, BOARD_TASK_LIMIT),
		env.DB.prepare("SELECT job_key, user_status, title, subtitle, url, updated_at, github_issue_number, github_issue_cache FROM board_items WHERE instance_id = ?1 AND user_id = ?2")
			.bind(instanceId, userId)
			.all<{ job_key: string; user_status: string | null; title: string; subtitle: string; url: string; updated_at: string; github_issue_number: number | null; github_issue_cache: string | null }>(),
		boardConfigForInstance(env, instanceId, userId),
		// Per-ticket conversation turns (#150), so a card can say it has been questioned. One
		// grouped read for the whole board rather than a read per card; the partial index from
		// migration 0088 keeps it off the runtime event firehose.
		env.DB.prepare(
			`SELECT task_id, COUNT(*) AS n FROM instance_runtime_task_events
     WHERE instance_id = ?1 AND user_id = ?2 AND type IN (${TICKET_TURN_TYPES_SQL})
     GROUP BY task_id`,
		)
			.bind(instanceId, userId)
			.all<{ task_id: string | null; n: number }>(),
	]);
	const { columns, view } = boardCfg;

	const threadTurnsByTask = new Map<string, number>();
	for (const r of threadRows.results ?? []) {
		if (r.task_id) threadTurnsByTask.set(r.task_id, Number(r.n) || 0);
	}

	const overlay = new Map<string, { user_status: string | null; title: string; subtitle: string; url: string; updated_at: string; github_issue_number: number | null; github_issue_cache: string | null }>();
	for (const r of overlayRows.results ?? []) overlay.set(r.job_key, r);

	// One card per job — newest attempt represents the card.
	const byKey = new Map<string, RawTask[]>();
	for (const t of tasks) {
		if (!isRecord(t)) continue;
		const task = t as RawTask;
		const key = jobKeyForTask(task);
		const arr = byKey.get(key);
		if (arr) arr.push(task); else byKey.set(key, [task]);
	}

	const items: BoardItemView[] = [];
	// Coding cards are keyed on a session, so what they report has to agree with that session and
	// with the runs behind it (#592). Collected here and joined in ONE pair of reads below rather
	// than a read per card — the board polls every 2.5s.
	const codingCards = new Map<string, BoardItemView>();
	for (const [jobKey, arr] of byKey) {
		arr.sort((a, b) => stamp(b) - stamp(a));
		const rep = arr[0];
		const label = taskLabel(rep);
		const runStatus = String(rep.status ?? "");
		const userStatus = overlay.get(jobKey)?.user_status ?? null;
		const latestTaskId = String(rep.id ?? "");
		const overlayRow = overlay.get(jobKey);
		const githubIssue = overlayRow ? parseCachedIssue(overlayRow.github_issue_cache) : undefined;
		const item: BoardItemView = {
			jobKey,
			latestTaskId,
			threadTurns: threadTurnsByTask.get(latestTaskId) ?? 0,
			title: label.title,
			subtitle: label.subtitle,
			description: taskDescription(rep),
			reasoning: typeof rep.reasoning === "string" && rep.reasoning.trim() ? rep.reasoning : undefined,
			url: typeof rep.input?.url === "string" ? rep.input.url : "",
			runStatus,
			userStatus,
			status: userStatus || runStatus,
			attempts: arr.map((t) => ({ id: String(t.id ?? ""), status: String(t.status ?? ""), updatedAt: t.updatedAt || t.createdAt || "" })),
			updatedAt: rep.updatedAt || rep.createdAt || "",
			...(githubIssue ? { githubIssue } : {}),
		};
		items.push(item);
		if (rep.type === CODING_SESSION_TASK_TYPE) {
			const sessionId = codingSessionIdFromCardId(jobKey);
			if (sessionId) codingCards.set(sessionId, item);
		}
	}

	// The read-time join `board.ts:334` never had. Every coding card's `attempts`, status and detail
	// are settled against the run that owns the work and the session it is keyed on — see
	// `board-runs.ts` for why this cannot be a write-through.
	if (codingCards.size) {
		const sessionIds = [...codingCards.keys()];
		const [runsBySession, sessionStates] = await Promise.all([
			codingRunsForSessions(env, instanceId, userId, sessionIds),
			codingSessionStates(env, instanceId, userId, sessionIds),
		]);
		for (const [sessionId, item] of codingCards) {
			const patch = reconcileCodingCard({
				runStatus: item.runStatus,
				description: item.description,
				attempts: item.attempts,
				runs: runsBySession.get(sessionId) ?? [],
				session: sessionStates.get(sessionId),
			});
			item.runStatus = patch.runStatus;
			item.description = patch.description;
			item.attempts = patch.attempts;
			// A human's own move still outranks the reconciliation, exactly as it outranks the writer.
			item.status = item.userStatus || patch.runStatus;
			if (patch.sessionEnded) item.sessionEnded = true;
		}
	}

	// Standalone durable cards: a job the user MOVED whose runtime tasks are gone
	// (cleared / aged out). These stand on the snapshot stored at move time so the
	// tracked pipeline card (e.g. Interview) doesn't vanish with its runs.
	for (const [jobKey, row] of overlay) {
		if (byKey.has(jobKey) || !row.user_status) continue;
		const githubIssue = parseCachedIssue(row.github_issue_cache);
		items.push({
			jobKey,
			latestTaskId: "",
			// A standalone card has no ticket left to open, so it can have no thread to show.
			threadTurns: 0,
			title: row.title || jobKey,
			subtitle: row.subtitle || "",
			description: "",
			url: row.url || "",
			runStatus: "",
			userStatus: row.user_status,
			status: row.user_status,
			attempts: [],
			updatedAt: row.updated_at || "",
			...(githubIssue ? { githubIssue } : {}),
		});
	}

	items.sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""));

	return { columns, items, view, truncated: tasks.length >= BOARD_TASK_LIMIT };
}

/** A patch to an instance's board config. `columns: null` (or an empty/invalid array)
 *  clears the override so the board falls back to the agent's columns. */
export interface BoardConfigPatch {
	columns?: BoardColumn[] | null;
	view?: BoardView;
}

/** At most this many columns per board — a sane ceiling shared by every editor. */
export const MAX_BOARD_COLUMNS = 20;

/**
 * Set an instance's per-instance board override (columns and/or view). The single
 * writer behind the console editor, the MCP `set_instance_board_config` tool, and the
 * agent's own `configure_board` tool. Returns the freshly-resolved {@link BoardConfig}.
 * Ownership must already be verified by the caller.
 */
export async function setInstanceBoardConfig(
	env: Env,
	instanceId: string,
	userId: string,
	patch: BoardConfigPatch,
): Promise<BoardConfig> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.first<{ config: string }>();
	const cfg = parseJson(row?.config);
	if (patch.columns !== undefined) {
		const clean = patch.columns === null ? undefined : sanitizeBoardColumns(patch.columns);
		if (clean?.length) cfg.boardColumns = clean.slice(0, MAX_BOARD_COLUMNS);
		else delete cfg.boardColumns; // null / empty / invalid → reset to the agent's columns
	}
	if (patch.view === "list" || patch.view === "kanban") cfg.boardView = patch.view;
	// Patch the two board keys individually rather than rewriting the whole blob (#231): the
	// agent's own `configure_board` tool can fire while the owner is saving Settings in the
	// console, and a whole-blob write would silently discard whichever landed first.
	if (cfg.boardColumns === undefined) await removeInstanceConfigKey(env, instanceId, userId, "boardColumns");
	else await patchInstanceConfig(env, instanceId, userId, "boardColumns", cfg.boardColumns);
	if (cfg.boardView !== undefined) await patchInstanceConfig(env, instanceId, userId, "boardView", cfg.boardView);
	return boardConfigForInstance(env, instanceId, userId);
}

/**
 * The agent's own `configure_board` tool: parse the model's arguments (a `columns`
 * JSON array, a `view`, or `reset`) and apply them to this instance's board. Returns
 * a short human-readable result for the tool log. This is the "customizable by the
 * agent itself" path — it writes through the same {@link setInstanceBoardConfig}.
 */
export async function configureBoardForAgent(
	env: Env,
	instanceId: string,
	userId: string,
	input: Record<string, unknown>,
): Promise<{ content: string; success: boolean }> {
	const patch: BoardConfigPatch = {};
	if (input.reset === true || input.reset === "true") {
		patch.columns = null;
	} else if (typeof input.columns === "string" && input.columns.trim()) {
		try {
			const parsed = JSON.parse(input.columns);
			if (!Array.isArray(parsed)) return { content: "`columns` must be a JSON array of {id,title,color?,statuses?,catchAll?}.", success: false };
			patch.columns = parsed as BoardColumn[];
		} catch {
			return { content: "`columns` must be valid JSON — an array of {id,title,color?,statuses?,catchAll?}.", success: false };
		}
	} else if (Array.isArray(input.columns)) {
		patch.columns = input.columns as BoardColumn[];
	}
	if (input.view === "list" || input.view === "kanban") patch.view = input.view;
	if (patch.columns === undefined && patch.view === undefined) {
		return { content: "Nothing to change — provide `columns` (JSON array), `view` (kanban|list), or reset:true.", success: false };
	}
	if (patch.columns?.length && !sanitizeBoardColumns(patch.columns)) {
		return { content: "Each column needs at least an `id` and a `title`.", success: false };
	}
	const cfg = await setInstanceBoardConfig(env, instanceId, userId, patch);
	return {
		content: `Board updated. View: ${cfg.view}. Columns (${cfg.columns.length}, source: ${cfg.source}): ${cfg.columns.map((c) => c.title).join(", ")}.`,
		success: true,
	};
}

/**
 * Snapshot fields so a moved card can stand alone once its runs are gone.
 *
 * A field left `undefined` means ABSENT — "I am not saying anything about this one, leave
 * whatever is stored alone". An explicit `""` means CLEAR it. Those are different
 * instructions and {@link setBoardItemStatus} keeps them apart, because collapsing absent
 * into `""` is exactly what wiped a card's title when a caller that only knows about
 * status (MCP's `set_board_item_status`) moved a card the console had already labelled
 * (#652).
 */
export interface BoardItemMeta {
	title?: string;
	subtitle?: string;
	url?: string;
}

/**
 * The display fields for a job as the board shows it RIGHT NOW — used to fill in what a
 * caller did not send, so a first move records a real card rather than an empty one.
 *
 * Only a card still backed by runtime tasks is returned. A standalone card is built by
 * {@link buildInstanceBoard} from the stored row as `title: row.title || jobKey`, so
 * snapshotting one would write the jobKey back into the title column as though it were a
 * title somebody chose — turning "nothing was ever recorded" into a stored fact, which is
 * the failure this snapshot exists to prevent.
 */
export async function liveBoardItemMeta(
	env: Env,
	instanceId: string,
	userId: string,
	jobKey: string,
): Promise<BoardItemMeta | null> {
	const board = await buildInstanceBoard(env, instanceId, userId);
	const card = board.items.find((i) => i.jobKey === jobKey);
	if (!card?.latestTaskId) return null;
	return { title: card.title, subtitle: card.subtitle, url: card.url };
}

/** Set (or clear, when status is null/empty) the human status override for a job. */
export async function setBoardItemStatus(
	env: Env,
	instanceId: string,
	userId: string,
	jobKey: string,
	status: string | null,
	meta: BoardItemMeta = {},
): Promise<void> {
	if (!status) {
		await env.DB.prepare("DELETE FROM board_items WHERE instance_id = ?1 AND user_id = ?2 AND job_key = ?3")
			.bind(instanceId, userId, jobKey)
			.run();
		return;
	}
	// An ABSENT display field binds NULL and the COALESCE leaves the stored value standing;
	// an explicit "" binds "" and clears it (#652). The columns are NOT NULL, so a fresh row
	// coalesces its own absent fields to "" instead — there is nothing there to preserve.
	// Written against the parameters rather than `excluded.*`, because `excluded.title` is
	// whatever the INSERT arm computed, which for an absent field is the "" we must not write.
	await env.DB.prepare(
		`INSERT INTO board_items (instance_id, user_id, job_key, user_status, title, subtitle, url, updated_at)
     VALUES (?1, ?2, ?3, ?4, COALESCE(?5, ''), COALESCE(?6, ''), COALESCE(?7, ''), datetime('now'))
     ON CONFLICT(instance_id, user_id, job_key) DO UPDATE SET
       user_status = excluded.user_status,
       title = COALESCE(?5, board_items.title),
       subtitle = COALESCE(?6, board_items.subtitle),
       url = COALESCE(?7, board_items.url),
       updated_at = excluded.updated_at`,
	)
		.bind(
			instanceId,
			userId,
			jobKey.slice(0, 400),
			status.slice(0, 80),
			meta.title === undefined ? null : meta.title.slice(0, 300),
			meta.subtitle === undefined ? null : meta.subtitle.slice(0, 300),
			meta.url === undefined ? null : meta.url.slice(0, 1000),
		)
		.run();
}

/** Delete a job's durable board-item row (used when a whole job is removed). */
export async function deleteBoardItem(env: Env, instanceId: string, userId: string, jobKey: string): Promise<void> {
	await env.DB.prepare("DELETE FROM board_items WHERE instance_id = ?1 AND user_id = ?2 AND job_key = ?3")
		.bind(instanceId, userId, jobKey)
		.run();
}

/**
 * Link (or unlink) a board card to a GitHub issue (#682). Stores the issue number as
 * a stable key and immediately fetches + caches the issue's projection (title/state/labels/url)
 * so the board can render it without a live GitHub call. Passing `null` unlinks.
 *
 * The card row is upserted if it does not exist yet (a card can be linked before it is moved).
 * The board column and the issue labels are independent axes — linking never touches
 * `user_status`.
 *
 * Returns `{ ok: true, issue }` on success, `{ ok: false, error }` when the issue cannot be
 * fetched (not found, private + no install, network down). A fetch failure does NOT block the
 * link — the number is stored and the cache stays empty; `refresh` can fill it later.
 */
export async function linkBoardItemGithubIssue(
	env: Env,
	instanceId: string,
	userId: string,
	jobKey: string,
	link: { repo: string; issueNumber: number } | null,
): Promise<{ ok: true; issue?: GithubIssueProjection } | { ok: false; error: string }> {
	if (!link) {
		// Unlink: clear the two github columns if the row exists.
		await env.DB.prepare(
			`UPDATE board_items SET github_issue_number = NULL, github_issue_cache = '', updated_at = datetime('now')
       WHERE instance_id = ?1 AND user_id = ?2 AND job_key = ?3`,
		).bind(instanceId, userId, jobKey).run();
		return { ok: true };
	}

	const { repo, issueNumber } = link;
	// Fetch the issue projection immediately so the row is warm on the first board read.
	const fetched = await readIssue(env, userId, repo, issueNumber);
	const cache = fetched ? serializeIssueCache(fetched) : "";

	// Upsert the row. The display fields (title/subtitle/url/user_status) are PRESERVED on
	// conflict — linking must not wipe a card that was already moved to a pipeline column.
	await env.DB.prepare(
		`INSERT INTO board_items (instance_id, user_id, job_key, user_status, title, subtitle, url, github_issue_number, github_issue_cache, updated_at)
     VALUES (?1, ?2, ?3, NULL, '', '', '', ?4, ?5, datetime('now'))
     ON CONFLICT(instance_id, user_id, job_key) DO UPDATE SET
       github_issue_number = excluded.github_issue_number,
       github_issue_cache   = excluded.github_issue_cache,
       updated_at           = excluded.updated_at`,
	).bind(instanceId, userId, jobKey.slice(0, 400), issueNumber, cache).run();

	if (!fetched) {
		return { ok: false, error: `Could not fetch issue #${issueNumber} from ${repo} — the number is stored but the cache is empty. Try refreshing later.` };
	}
	return { ok: true, issue: parseCachedIssue(cache) };
}

/**
 * Refresh the cached GitHub issue projections for every linked card on this instance's
 * board (#682). Fetches each distinct (repo, issue) pair once and updates the stored
 * cache. Silently skips cards whose fetch fails so a single unreachable issue cannot
 * block the others. Returns a count of how many were refreshed vs skipped.
 *
 * `boardGithubRepo` must be set in the instance config to know WHICH repo to use for
 * cards that were linked without an explicit repo stored per-row — the per-instance
 * repo setting is the authority here.
 */
export async function refreshBoardGithubIssues(
	env: Env,
	instanceId: string,
	userId: string,
	githubRepo: string,
): Promise<{ refreshed: number; skipped: number }> {
	// All linked cards for this instance.
	const rows = await env.DB.prepare(
		`SELECT job_key, github_issue_number FROM board_items
     WHERE instance_id = ?1 AND user_id = ?2 AND github_issue_number IS NOT NULL`,
	).bind(instanceId, userId).all<{ job_key: string; github_issue_number: number }>();

	const linked = rows.results ?? [];
	if (!linked.length) return { refreshed: 0, skipped: 0 };

	let refreshed = 0;
	let skipped = 0;

	await Promise.all(
		linked.map(async (row) => {
			const fetched = await readIssue(env, userId, githubRepo, row.github_issue_number);
			if (!fetched) { skipped++; return; }
			await env.DB.prepare(
				`UPDATE board_items SET github_issue_cache = ?4, updated_at = datetime('now')
         WHERE instance_id = ?1 AND user_id = ?2 AND job_key = ?3`,
			).bind(instanceId, userId, row.job_key, serializeIssueCache(fetched)).run();
			refreshed++;
		}),
	);

	return { refreshed, skipped };
}

/**
 * The one terminal-status set shared across the clear-finished path. Deliberately
 * EXCLUDES `blocked` (needs-you, kept active) and the human pipeline stages
 * `interview`/`offer`/`accepted`/`rejected` (a card the user is tracking must not
 * be wiped by a bulk clear). Keep this in sync with the console's finished set.
 */
export const FINISHED_STATUSES = ["completed", "submitted", "failed", "cancelled", "expired"];

/** Remove durable board-item rows whose human status is terminal (Clear finished). */
export async function clearFinishedBoardItems(env: Env, instanceId: string, userId: string): Promise<void> {
	const placeholders = FINISHED_STATUSES.map((_, i) => `?${i + 3}`).join(", ");
	await env.DB.prepare(
		`DELETE FROM board_items WHERE instance_id = ?1 AND user_id = ?2 AND user_status IN (${placeholders})`,
	)
		.bind(instanceId, userId, ...FINISHED_STATUSES)
		.run();
}
