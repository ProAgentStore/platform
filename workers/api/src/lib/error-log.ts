/**
 * Durable error log (D1 `error_log`). Failures at the key hotspots write here so
 * a reason is never thrown away — readable via GET /v1/errors. See migration 0034.
 */
import type { Env } from "../types.js";

export interface ErrorLogInput {
	/** Where it failed: 'keys-proxy' | 'auth' | 'job-apply' | 'coding' | 'chat' | … */
	source: string;
	/** The failure reason (upstream body, exception message, etc.). */
	message: string;
	/** The affected user, when known. */
	userId?: string | null;
	/** HTTP-ish status when applicable. */
	status?: number;
	/** Structured extras: host, path, provider, instanceId, taskId, … */
	context?: Record<string, unknown>;
}

/**
 * Persist a failure. NEVER throws — error logging must not break the request path
 * it is observing. Sizes are bounded so one huge upstream body can't bloat a row.
 */
export async function logError(env: Env, e: ErrorLogInput): Promise<void> {
	try {
		await env.DB.prepare(
			"INSERT INTO error_log (id, user_id, source, status, message, context) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
		)
			.bind(
				crypto.randomUUID(),
				e.userId ?? null,
				String(e.source).slice(0, 64),
				typeof e.status === "number" ? e.status : null,
				String(e.message ?? "").slice(0, 2000) || "(no message)",
				e.context ? JSON.stringify(e.context).slice(0, 4000) : null,
			)
			.run();
	} catch (err) {
		// Last resort — the logger itself must not throw.
		console.error("[error-log] failed to persist:", err instanceof Error ? err.message : String(err));
	}
}

export interface ErrorRow {
	id: string;
	created_at: string;
	user_id: string | null;
	source: string;
	status: number | null;
	message: string;
	context: string | null;
}

/** Read recent errors — for one user, or all (admin). Newest first. */
export async function listErrors(
	env: Env,
	opts: { userId?: string; all?: boolean; limit?: number; source?: string },
): Promise<ErrorRow[]> {
	const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
	const where: string[] = [];
	const binds: unknown[] = [];
	if (!opts.all) {
		binds.push(opts.userId ?? "");
		where.push(`user_id = ?${binds.length}`);
	}
	if (opts.source) {
		binds.push(opts.source);
		where.push(`source = ?${binds.length}`);
	}
	const sql = `SELECT id, created_at, user_id, source, status, message, context FROM error_log${
		where.length ? ` WHERE ${where.join(" AND ")}` : ""
	} ORDER BY created_at DESC LIMIT ${limit}`;
	const res = await env.DB.prepare(sql)
		.bind(...binds)
		.all<ErrorRow>();
	return res.results ?? [];
}
