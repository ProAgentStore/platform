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
	tokenExpiresAt: string | null;
	tokenRevokedAt: string | null;
	/** The only FWS draft session this job is permitted to touch. */
	fwsSessionId: string | null;
	/** A create_site call is a one-shot external side effect, even before it returns. */
	createStartedAt: string | null;
	noindexConfirmed: boolean;
	status: "queued" | "running" | "completed" | "failed";
	evidence: string | null;
}

export interface WebsiteBuilderJobCall {
	tool: string;
	args: Record<string, unknown>;
	result: string;
	success: boolean;
	/** Provenance stamped by the PAGS broker, never supplied by the local CLI. */
	metadata: Record<string, unknown>;
}

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

function jobFromRow(row: Record<string, unknown>): WebsiteBuilderJob {
	return {
		id: String(row.id ?? ""), instanceId: String(row.instance_id ?? ""), userId: String(row.user_id ?? ""), mcpUrl: String(row.mcp_url ?? ""), tokenHash: String(row.token_hash ?? ""),
		tokenExpiresAt: typeof row.token_expires_at === "string" ? row.token_expires_at : null,
		tokenRevokedAt: typeof row.token_revoked_at === "string" ? row.token_revoked_at : null,
		fwsSessionId: typeof row.fws_session_id === "string" && row.fws_session_id ? row.fws_session_id : null,
		createStartedAt: typeof row.create_started_at === "string" ? row.create_started_at : null,
		noindexConfirmed: Number(row.noindex_confirmed) === 1,
		status: (["queued", "running", "completed", "failed"].includes(String(row.status)) ? row.status : "failed") as WebsiteBuilderJob["status"],
		evidence: typeof row.evidence === "string" ? row.evidence : null,
	};
}

const JOB_COLUMNS = "id, instance_id, user_id, mcp_url, token_hash, token_expires_at, token_revoked_at, fws_session_id, create_started_at, noindex_confirmed, status, evidence";

export async function createWebsiteBuilderJob(
	env: Env,
	input: { id: string; instanceId: string; userId: string; mcpUrl: string; token: string; idempotencyKey: string },
): Promise<boolean> {
	await env.DB.prepare(
		`INSERT OR IGNORE INTO website_builder_jobs (id, instance_id, user_id, mcp_url, idempotency_key, token_hash, token_expires_at, status, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now', '+30 minutes'), 'queued', datetime('now'), datetime('now'))`,
	).bind(input.id, input.instanceId, input.userId, input.mcpUrl, input.idempotencyKey, await websiteBuilderTokenHash(input.token)).run();
	// Do not trust D1's affected-row metadata here: several test adapters deliberately
	// omit it. The id is random, so seeing our own id is an unambiguous reservation.
	const reserved = await findWebsiteBuilderJobByKey(env, input.instanceId, input.idempotencyKey);
	return reserved?.id === input.id;
}

export async function findWebsiteBuilderJobByKey(env: Env, instanceId: string, idempotencyKey: string): Promise<WebsiteBuilderJob | null> {
	const row = await env.DB.prepare(`SELECT ${JOB_COLUMNS} FROM website_builder_jobs WHERE instance_id = ?1 AND idempotency_key = ?2`).bind(instanceId, idempotencyKey).first<Record<string, unknown>>();
	if (!row) return null;
	return jobFromRow(row);
}

export async function getWebsiteBuilderJob(env: Env, id: string): Promise<WebsiteBuilderJob | null> {
	const row = await env.DB.prepare(
		`SELECT ${JOB_COLUMNS} FROM website_builder_jobs WHERE id = ?1`,
	).bind(id).first<Record<string, unknown>>();
	if (!row || typeof row.id !== "string") return null;
	return jobFromRow(row);
}

/**
 * The runner assigns task ids. Reserve the idempotency key before asking it to start,
 * then attach that externally assigned id exactly once. This closes the two-tab race
 * that otherwise creates two external FWS drafts before either job row exists.
 */
export async function attachWebsiteBuilderRuntimeTask(env: Env, reservationId: string, taskId: string): Promise<boolean> {
	const out = await env.DB.prepare(
		"UPDATE website_builder_jobs SET id = ?2, updated_at = datetime('now') WHERE id = ?1 AND status = 'queued'",
	).bind(reservationId, taskId).run();
	return Number(out.meta?.changes ?? 0) === 1;
}

/** Claim create_site before the remote call. A second concurrent request cannot mint another draft. */
export async function claimWebsiteBuilderSiteCreation(env: Env, id: string): Promise<boolean> {
	const out = await env.DB.prepare(
		"UPDATE website_builder_jobs SET create_started_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1 AND status = 'running' AND fws_session_id IS NULL AND create_started_at IS NULL",
	).bind(id).run();
	return Number(out.meta?.changes ?? 0) === 1;
}

export async function bindWebsiteBuilderFwsSession(env: Env, id: string, sessionId: string): Promise<boolean> {
	const out = await env.DB.prepare(
		"UPDATE website_builder_jobs SET fws_session_id = ?2, updated_at = datetime('now') WHERE id = ?1 AND status = 'running' AND fws_session_id IS NULL AND create_started_at IS NOT NULL",
	).bind(id, sessionId).run();
	return Number(out.meta?.changes ?? 0) === 1;
}

export async function confirmWebsiteBuilderNoindex(env: Env, id: string): Promise<void> {
	await env.DB.prepare(
		"UPDATE website_builder_jobs SET noindex_confirmed = 1, updated_at = datetime('now') WHERE id = ?1 AND status = 'running' AND fws_session_id IS NOT NULL",
	).bind(id).run();
}

/** D1 datetime strings are UTC but do not carry a suffix. Missing/invalid expiry fails closed. */
export function websiteBuilderTokenActive(job: WebsiteBuilderJob, now = Date.now()): boolean {
	if (job.tokenRevokedAt || !job.tokenExpiresAt) return false;
	const expires = Date.parse(`${job.tokenExpiresAt.replace(" ", "T")}Z`);
	return Number.isFinite(expires) && expires > now;
}

export async function markWebsiteBuilderJob(
	env: Env, id: string, status: "running" | "completed" | "failed", evidence?: unknown,
): Promise<void> {
	await env.DB.prepare(
		`UPDATE website_builder_jobs
		 SET status = ?2, evidence = COALESCE(?3, evidence), updated_at = datetime('now'),
		     completed_at = CASE WHEN ?2 IN ('completed', 'failed') THEN datetime('now') ELSE completed_at END,
		     token_revoked_at = CASE WHEN ?2 IN ('completed', 'failed') THEN datetime('now') ELSE token_revoked_at END
		 WHERE id = ?1`,
	).bind(id, status, evidence === undefined ? null : JSON.stringify(evidence)).run();
}

export async function recordWebsiteBuilderJobCall(env: Env, input: { jobId: string; tool: string; args: Record<string, unknown>; result: string; success: boolean; metadata: Record<string, unknown> }): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO website_builder_job_calls (id, job_id, tool, args, result, metadata, success, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))",
	).bind(crypto.randomUUID(), input.jobId, input.tool, JSON.stringify(input.args), input.result.slice(0, 20000), JSON.stringify(input.metadata), input.success ? 1 : 0).run();
}

export async function listWebsiteBuilderJobCalls(env: Env, jobId: string): Promise<WebsiteBuilderJobCall[]> {
	const { results } = await env.DB.prepare("SELECT tool, args, result, metadata, success FROM website_builder_job_calls WHERE job_id = ?1 ORDER BY created_at ASC").bind(jobId).all<Record<string, unknown>>();
	return (results ?? []).map((row) => {
		let args: Record<string, unknown> = {};
		let metadata: Record<string, unknown> = {};
		try { const parsed = JSON.parse(String(row.args ?? "{}")); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed; } catch { /* stored fact remains usable */ }
		try { const parsed = JSON.parse(String(row.metadata ?? "{}")); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed; } catch { /* stored fact remains usable */ }
		return { tool: String(row.tool ?? ""), args, result: String(row.result ?? ""), success: Number(row.success) === 1, metadata };
	});
}
