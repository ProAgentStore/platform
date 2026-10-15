import type { Env } from "../types.js";

/**
 * The two writes every job-lead intake shares (#1096): the browser-verification queue row, and the set
 * of jobs that already have an application. A LEAF — it imports nothing from the lead or local-browser
 * modules — so the Gmail, pasted-URL and local-browser research intakes can all use it without the
 * research run's sync importing back into itself.
 */
type DB = Pick<Env, "DB">;

export const clip = (s: string | null | undefined, n = 300) => (s ? s.slice(0, n) : null);

export async function enqueueBrowserVerification(
	env: DB,
	input: { instanceId: string; userId: string; leadId: string; workKey: string | null; canonicalUrl: string; expectedTitle: string | null; expectedCompany: string | null; reason: string },
	now = Date.now(),
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO job_lead_browser_verifications (instance_id, lead_id, user_id, work_key, canonical_url, expected_title, expected_company, state, attempts, next_attempt_at, awaiting_since, last_detail, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'awaiting', 0, ?8, ?8, ?9, ?8, ?8)
		 ON CONFLICT(instance_id, lead_id) DO NOTHING`,
	)
		.bind(input.instanceId, input.leadId, input.userId, input.workKey, input.canonicalUrl, clip(input.expectedTitle), clip(input.expectedCompany, 160), now, `The server could not check the posting (${input.reason}); waiting for browser verification.`)
		.run();
}

/** Work keys this owner already has an application for — of any status, from any Tailor. */
export async function appliedWorkKeys(env: DB, userId: string): Promise<Set<string>> {
	const { results } = await env.DB.prepare("SELECT DISTINCT work_key FROM job_applications WHERE user_id = ?1 AND work_key IS NOT NULL").bind(userId).all<{ work_key: string }>();
	return new Set((results ?? []).map((r) => r.work_key));
}
