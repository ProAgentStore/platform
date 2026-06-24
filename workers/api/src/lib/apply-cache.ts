import type { Env } from "../types.js";

/** The ATS host an application targets, used as the per-ATS cache key (no www). */
export function atsHost(url: string): string {
	try {
		return new URL(url).host.replace(/^www\./, "");
	} catch {
		return "";
	}
}

/** Notes from the last successful application on this ATS (fed into the prompt). */
export async function getAtsCacheHint(env: Env, userId: string, host: string): Promise<string | undefined> {
	if (!host) return undefined;
	const row = await env.DB.prepare("SELECT notes FROM ats_apply_cache WHERE user_id = ?1 AND host = ?2")
		.bind(userId, host)
		.first<{ notes: string }>();
	return row?.notes || undefined;
}

/** Record the action path that just succeeded on this ATS, for next time. */
export async function saveAtsCache(env: Env, userId: string, host: string, transcript: string[]): Promise<void> {
	if (!host || transcript.length === 0) return;
	const notes = transcript.map((a, i) => `${i + 1}. ${a}`).join("\n");
	await env.DB.prepare(
		`INSERT INTO ats_apply_cache (user_id, host, notes, steps, updated_at)
		 VALUES (?1, ?2, ?3, ?4, datetime('now'))
		 ON CONFLICT(user_id, host) DO UPDATE SET notes = excluded.notes, steps = excluded.steps, updated_at = excluded.updated_at`,
	)
		.bind(userId, host, notes, transcript.length)
		.run();
}
