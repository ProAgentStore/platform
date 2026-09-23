import type { Env } from "../types.js";

export const WEBSITE_BUILDER_DRAFT_TOOLS = new Set([
	"list_templates", "create_site", "list_sections", "read_section", "add_section",
	"bulk_update_sections", "set_meta", "set_contact", "set_social",
	"get_quality_report", "get_rendered_preview", "capture_preview",
]);

export interface WebsiteBuilderJob {
	id: string;
	instanceId: string;
	userId: string;
	mcpUrl: string;
	tokenHash: string;
	status: "queued" | "running" | "completed" | "failed";
	evidence: string | null;
}

export interface WebsiteBuilderJobCall { tool: string; args: Record<string, unknown>; result: string; success: boolean; }

const encoder = new TextEncoder();

export async function websiteBuilderTokenHash(token: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createWebsiteBuilderToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function websiteBuilderToolAllowed(tool: unknown): tool is string {
	return typeof tool === "string" && WEBSITE_BUILDER_DRAFT_TOOLS.has(tool);
}

/** Additional per-call invariants inside the otherwise-safe draft allowlist. */
export function websiteBuilderToolInputAllowed(tool: string, args: Record<string, unknown>): boolean {
	// A draft can never remove its noindex protection through the subscription worker.
	return tool !== "set_meta" || args.noindex === true;
}

export async function createWebsiteBuilderJob(
	env: Env,
	input: { id: string; instanceId: string; userId: string; mcpUrl: string; token: string; idempotencyKey: string },
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO website_builder_jobs (id, instance_id, user_id, mcp_url, idempotency_key, token_hash, status, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', datetime('now'), datetime('now'))`,
	).bind(input.id, input.instanceId, input.userId, input.mcpUrl, input.idempotencyKey, await websiteBuilderTokenHash(input.token)).run();
}

export async function findWebsiteBuilderJobByKey(env: Env, instanceId: string, idempotencyKey: string): Promise<WebsiteBuilderJob | null> {
	const row = await env.DB.prepare("SELECT id, instance_id, user_id, mcp_url, token_hash, status, evidence FROM website_builder_jobs WHERE instance_id = ?1 AND idempotency_key = ?2").bind(instanceId, idempotencyKey).first<Record<string, unknown>>();
	if (!row) return null;
	return { id: String(row.id), instanceId: String(row.instance_id), userId: String(row.user_id), mcpUrl: String(row.mcp_url), tokenHash: String(row.token_hash), status: (["queued", "running", "completed", "failed"].includes(String(row.status)) ? row.status : "failed") as WebsiteBuilderJob["status"], evidence: typeof row.evidence === "string" ? row.evidence : null };
}

export async function getWebsiteBuilderJob(env: Env, id: string): Promise<WebsiteBuilderJob | null> {
	const row = await env.DB.prepare(
		"SELECT id, instance_id, user_id, mcp_url, token_hash, status, evidence FROM website_builder_jobs WHERE id = ?1",
	).bind(id).first<Record<string, unknown>>();
	if (!row || typeof row.id !== "string") return null;
	return {
		id: row.id,
		instanceId: String(row.instance_id ?? ""), userId: String(row.user_id ?? ""), mcpUrl: String(row.mcp_url ?? ""), tokenHash: String(row.token_hash ?? ""),
		status: (["queued", "running", "completed", "failed"].includes(String(row.status)) ? row.status : "failed") as WebsiteBuilderJob["status"],
		evidence: typeof row.evidence === "string" ? row.evidence : null,
	};
}

export async function markWebsiteBuilderJob(
	env: Env, id: string, status: "running" | "completed" | "failed", evidence?: unknown,
): Promise<void> {
	await env.DB.prepare(
		`UPDATE website_builder_jobs
		 SET status = ?2, evidence = COALESCE(?3, evidence), updated_at = datetime('now'),
		     completed_at = CASE WHEN ?2 IN ('completed', 'failed') THEN datetime('now') ELSE completed_at END
		 WHERE id = ?1`,
	).bind(id, status, evidence === undefined ? null : JSON.stringify(evidence)).run();
}

export async function recordWebsiteBuilderJobCall(env: Env, input: { jobId: string; tool: string; args: Record<string, unknown>; result: string; success: boolean }): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO website_builder_job_calls (id, job_id, tool, args, result, success, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))",
	).bind(crypto.randomUUID(), input.jobId, input.tool, JSON.stringify(input.args), input.result.slice(0, 20000), input.success ? 1 : 0).run();
}

export async function listWebsiteBuilderJobCalls(env: Env, jobId: string): Promise<WebsiteBuilderJobCall[]> {
	const { results } = await env.DB.prepare("SELECT tool, args, result, success FROM website_builder_job_calls WHERE job_id = ?1 ORDER BY created_at ASC").bind(jobId).all<Record<string, unknown>>();
	return (results ?? []).map((row) => {
		let args: Record<string, unknown> = {};
		try { const parsed = JSON.parse(String(row.args ?? "{}")); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed; } catch { /* stored fact remains usable */ }
		return { tool: String(row.tool ?? ""), args, result: String(row.result ?? ""), success: Number(row.success) === 1 };
	});
}
