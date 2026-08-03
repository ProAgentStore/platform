// Shared helpers + the ctx threaded to every instance-tool group registrar. Split out of the
// old monolithic instance-tools.ts (#135); behaviour-identical (same helpers, verbatim).
import { z } from "zod";
import { authedCall, type McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";

export type TokenResolver = (provided?: string) => string | null;
export type SafetyResolver = (provided?: string) => SafetyContext;

/** Shared deps every group registrar needs — built once by index.ts. */
export interface InstanceToolsCtx {
	env: McpEnv;
	tokenFor: TokenResolver;
	safetyFor: SafetyResolver;
	groups: Set<string>;
}

export const triggerConfigSchema = z.object({
	title: z.string().optional(),
	description: z.string().optional(),
	source: z.string().optional(),
	source_url: z.string().optional(),
	provider: z.enum(["google_drive", "zoho_workdrive"]).optional(),
	grant_id: z.string().optional(),
	folder_id: z.string().optional(),
	limit: z.number().int().min(1).max(20).optional(),
	query: z.string().optional(),
	pipeline: z.string().optional(),
	collection: z.string().optional(),
	url: z.string().optional().describe("run_browse: the start URL for the scheduled browser task."),
	dry_run: z.boolean().optional().describe("run_browse: walk the flow but block the committing clicks."),
	jitter_minutes: z.number().int().min(0).max(720).optional().describe("cron: randomise the fire time by ± this many minutes (avoid firing exactly on the dot)."),
}).optional();

export interface InstanceSummary {
	id: string;
	agent_id: string;
	status: string;
	slug?: string;
	name?: string;
	description?: string;
	category?: string;
}

export async function findInstanceForAgent(
	env: McpEnv,
	token: string,
	agentId: string,
): Promise<InstanceSummary | null> {
	const data = (await authedCall(
		"/v1/instances/my/instances",
		token,
		{},
		env,
	)) as { instances?: InstanceSummary[]; error?: string };
	if (data.error) return null;
	return (data.instances || []).find(
		(i) => i.agent_id === agentId || i.slug === agentId || i.id === agentId,
	) || null;
}

export function normalizeTriggerConfig(
	config: z.infer<typeof triggerConfigSchema>,
): Record<string, unknown> {
	if (!config) return {};
	const out: Record<string, unknown> = {};
	if (config.title !== undefined) out.title = config.title;
	if (config.description !== undefined) out.description = config.description;
	if (config.source !== undefined) out.source = config.source;
	if (config.source_url !== undefined) out.sourceUrl = config.source_url;
	if (config.provider !== undefined) out.provider = config.provider;
	if (config.grant_id !== undefined) out.grantId = config.grant_id;
	if (config.folder_id !== undefined) out.folderId = config.folder_id;
	if (config.limit !== undefined) out.limit = config.limit;
	if (config.query !== undefined) out.query = config.query;
	if (config.pipeline !== undefined) out.pipeline = config.pipeline;
	if (config.collection !== undefined) out.collection = config.collection;
	if (config.url !== undefined) out.url = config.url;
	if (config.dry_run !== undefined) out.dryRun = config.dry_run;
	if (config.jitter_minutes !== undefined) out.jitterMinutes = config.jitter_minutes;
	return out;
}

export interface BoardColumn { id: string; title: string; statuses?: string[]; catchAll?: boolean }
export interface BoardItem { jobKey: string; title: string; subtitle?: string; description?: string; status: string; runStatus?: string; userStatus?: string | null; url?: string; attempts?: unknown[]; latestTaskId?: string }

export function columnFor(cols: BoardColumn[], status: string): string | null {
	for (const c of cols) if (c.statuses?.includes(status) || c.id === status) return c.id;
	const catchAll = cols.find((c) => c.catchAll);
	return catchAll ? catchAll.id : null;
}

/**
 * Group the API's flat board items (already ONE card per job, with effective
 * status + attempts + human overrides) into the agent's configured columns for a
 * readable answer. The API (lib/board.ts) owns the board shape; this just buckets.
 */
export function groupBoard(data: unknown): unknown {
	const cols = (isRec(data) && Array.isArray(data.columns) ? data.columns : []) as BoardColumn[];
	const items = (isRec(data) && Array.isArray(data.items) ? data.items : []) as BoardItem[];
	const board: Record<string, unknown[]> = {};
	const other: unknown[] = [];
	for (const it of items) {
		const card = {
			jobKey: it.jobKey,
			label: it.subtitle ? `${it.title} (${it.subtitle})` : it.title,
			status: it.status,
			runStatus: it.runStatus,
			moved: it.userStatus ? true : undefined,
			attempts: Array.isArray(it.attempts) ? it.attempts.length : undefined,
			detail: it.description,
			url: it.url,
			latestTaskId: it.latestTaskId,
		};
		const colId = columnFor(cols, String(it.status ?? ""));
		if (!colId) { other.push(card); continue; }
		const title = cols.find((c) => c.id === colId)?.title ?? colId;
		if (!board[title]) board[title] = [];
		board[title].push(card);
	}
	if (other.length) board.Other = other;
	const truncated = isRec(data) && data.truncated === true;
	return {
		columns: cols.map((c) => c.title),
		board,
		jobCount: items.length,
		...(truncated ? { truncated: true, truncatedNote: "Only the most recent runtime tasks were read — some older jobs may be missing." } : {}),
		note: "One card per job (retries of the same job collapse into one; `attempts` = run count). `moved:true` means a human set the status. Failed = the run couldn't finish; Blocked = the agent stopped needing you.",
	};
}

export function isRec(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}
