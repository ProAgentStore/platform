import type { Env } from "../types.js";

/**
 * A stable, strong password for ATS account creation — the SAME every run for a
 * given user, so a second application to a site where the user already has an
 * account can log in instead of failing to re-register. Derived (HMAC of the
 * user id under the session secret), so it's reproducible without storage and
 * not guessable. Always contains upper/lower/digit/symbol (the "Pj9!" prefix).
 */
export async function deriveJobPassword(env: Env, userId: string): Promise<string> {
	const secret = env.SESSION_SIGNING_KEY || "pags-fallback-secret";
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`jobpw:${userId}`));
	const b64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, "");
	return `Pj9!${b64.slice(0, 16)}`;
}

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

/** Record the action path (incl. what failed) from a run on this ATS, for next time + transparency. */
export async function saveAtsCache(env: Env, userId: string, host: string, transcript: string[], outcome = "submitted"): Promise<void> {
	if (!host || transcript.length === 0) return;
	const notes = transcript.map((a, i) => `${i + 1}. ${a}`).join("\n");
	await env.DB.prepare(
		`INSERT INTO ats_apply_cache (user_id, host, notes, steps, outcome, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
		 ON CONFLICT(user_id, host) DO UPDATE SET notes = excluded.notes, steps = excluded.steps, outcome = excluded.outcome, updated_at = excluded.updated_at`,
	)
		.bind(userId, host, notes, transcript.length, outcome)
		.run();
}

/** All the user's per-ATS learnings (for the transparency view). */
export async function listAtsCache(env: Env, userId: string): Promise<Array<{ host: string; outcome?: string; steps?: number; notes: string; updatedAt: string }>> {
	const res = await env.DB.prepare("SELECT host, outcome, steps, notes, updated_at FROM ats_apply_cache WHERE user_id = ?1 ORDER BY updated_at DESC")
		.bind(userId)
		.all<{ host: string; outcome: string | null; steps: number | null; notes: string; updated_at: string }>();
	return (res.results ?? []).map((r) => ({ host: r.host, outcome: r.outcome ?? undefined, steps: r.steps ?? undefined, notes: r.notes, updatedAt: r.updated_at }));
}
