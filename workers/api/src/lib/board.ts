import type { Env } from "../types.js";
import { mirroredRuntimeTasks, isRecord } from "../routes/instances-runtime.js";
import { agentCapabilities, type BoardColumn } from "./agent-capabilities.js";

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
	url: string;
	/** The newest run's status. */
	runStatus: string;
	/** A human status override (moved into a pipeline column), if any. */
	userStatus: string | null;
	/** Effective status = userStatus ?? runStatus — where the card lives. */
	status: string;
	attempts: BoardAttempt[];
	updatedAt: string;
}

export interface InstanceBoard {
	columns: BoardColumn[];
	items: BoardItemView[];
	/** True when the runtime-task window was hit — older jobs may be missing. */
	truncated: boolean;
}

/** How many recent runtime tasks the board reads before grouping into jobs. */
const BOARD_TASK_LIMIT = 1000;

interface RawTask {
	id?: string;
	type?: string;
	status?: string;
	title?: string;
	subtitle?: string;
	description?: string;
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
	"setup.fags_browser_runtime": "Runner setup",
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

/** Resolve the agent's declared board columns for an instance (per-surface default). */
export async function columnsForInstance(env: Env, instanceId: string, userId: string): Promise<BoardColumn[]> {
	const row = await env.DB.prepare(
		`SELECT a.slug AS slug, a.category AS category, a.config AS config
     FROM agent_instances i JOIN agents a ON a.id = i.agent_id
     WHERE i.id = ?1 AND i.user_id = ?2`,
	).bind(instanceId, userId).first<{ slug: string; category: string; config: string }>();
	return agentCapabilities({ slug: row?.slug, category: row?.category, config: row?.config }).boardColumns;
}

/** Build the instance's single work board: configured columns + one card per job. */
export async function buildInstanceBoard(env: Env, instanceId: string, userId: string): Promise<InstanceBoard> {
	const [tasks, overlayRows, columns] = await Promise.all([
		mirroredRuntimeTasks(env, instanceId, userId, BOARD_TASK_LIMIT),
		env.DB.prepare("SELECT job_key, user_status, title, subtitle, url, updated_at FROM board_items WHERE instance_id = ?1 AND user_id = ?2")
			.bind(instanceId, userId)
			.all<{ job_key: string; user_status: string | null; title: string; subtitle: string; url: string; updated_at: string }>(),
		columnsForInstance(env, instanceId, userId),
	]);

	const overlay = new Map<string, { user_status: string | null; title: string; subtitle: string; url: string; updated_at: string }>();
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
	for (const [jobKey, arr] of byKey) {
		arr.sort((a, b) => stamp(b) - stamp(a));
		const rep = arr[0];
		const label = taskLabel(rep);
		const runStatus = String(rep.status ?? "");
		const userStatus = overlay.get(jobKey)?.user_status ?? null;
		items.push({
			jobKey,
			latestTaskId: String(rep.id ?? ""),
			title: label.title,
			subtitle: label.subtitle,
			description: taskDescription(rep),
			url: typeof rep.input?.url === "string" ? rep.input.url : "",
			runStatus,
			userStatus,
			status: userStatus || runStatus,
			attempts: arr.map((t) => ({ id: String(t.id ?? ""), status: String(t.status ?? ""), updatedAt: t.updatedAt || t.createdAt || "" })),
			updatedAt: rep.updatedAt || rep.createdAt || "",
		});
	}

	// Standalone durable cards: a job the user MOVED whose runtime tasks are gone
	// (cleared / aged out). These stand on the snapshot stored at move time so the
	// tracked pipeline card (e.g. Interview) doesn't vanish with its runs.
	for (const [jobKey, row] of overlay) {
		if (byKey.has(jobKey) || !row.user_status) continue;
		items.push({
			jobKey,
			latestTaskId: "",
			title: row.title || jobKey,
			subtitle: row.subtitle || "",
			description: "",
			url: row.url || "",
			runStatus: "",
			userStatus: row.user_status,
			status: row.user_status,
			attempts: [],
			updatedAt: row.updated_at || "",
		});
	}

	items.sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""));

	return { columns, items, truncated: tasks.length >= BOARD_TASK_LIMIT };
}

/** Snapshot fields so a moved card can stand alone once its runs are gone. */
export interface BoardItemMeta {
	title?: string;
	subtitle?: string;
	url?: string;
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
	await env.DB.prepare(
		`INSERT INTO board_items (instance_id, user_id, job_key, user_status, title, subtitle, url, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))
     ON CONFLICT(instance_id, user_id, job_key) DO UPDATE SET
       user_status = excluded.user_status,
       title = excluded.title,
       subtitle = excluded.subtitle,
       url = excluded.url,
       updated_at = excluded.updated_at`,
	)
		.bind(instanceId, userId, jobKey.slice(0, 400), status.slice(0, 80), (meta.title ?? "").slice(0, 300), (meta.subtitle ?? "").slice(0, 300), (meta.url ?? "").slice(0, 1000))
		.run();
}

/** Delete a job's durable board-item row (used when a whole job is removed). */
export async function deleteBoardItem(env: Env, instanceId: string, userId: string, jobKey: string): Promise<void> {
	await env.DB.prepare("DELETE FROM board_items WHERE instance_id = ?1 AND user_id = ?2 AND job_key = ?3")
		.bind(instanceId, userId, jobKey)
		.run();
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
