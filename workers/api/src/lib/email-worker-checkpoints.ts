// Processing checkpoint and per-run budget for the worker-backed mailbox (#1278).
//
// The checkpoint is the set of provider message ids an instance has HANDLED on a connection (read in full, or replied to).
// A list skips them, so a repeated scan costs nothing for mail already dealt with, and it says truthfully how much it skipped
// and whether more remains. The budget is a counter per run: the limits are code, so they hold however many separate tool
// calls a run makes and whatever the instance's prompt says.
import type { Env } from "../types.js";

/** What one run may spend, deterministically. */
export const RUN_BUDGET = { summaries: 60, reads: 6, bodyChars: 60_000 } as const;

export interface BudgetUse {
	summaries: number;
	reads: number;
	bodyChars: number;
}

/** The key a run's counter lives under: the run id, else the hour (a caller with no run id still cannot loop unbounded). */
export function runKeyFor(traceId: string | undefined, now = new Date()): string {
	return traceId?.trim() || `hour:${now.toISOString().substring(0, 13)}`;
}

export async function budgetUsed(env: Env, instanceId: string, runKey: string): Promise<BudgetUse> {
	const row = await env.DB.prepare("SELECT summaries, reads, body_chars FROM email_worker_run_budget WHERE instance_id = ?1 AND run_key = ?2").bind(instanceId, runKey).first<{ summaries: number; reads: number; body_chars: number }>();
	return { summaries: row?.summaries ?? 0, reads: row?.reads ?? 0, bodyChars: row?.body_chars ?? 0 };
}

export async function chargeBudget(env: Env, instanceId: string, runKey: string, spend: Partial<BudgetUse>): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO email_worker_run_budget (instance_id, run_key, summaries, reads, body_chars) VALUES (?1, ?2, ?3, ?4, ?5)
		 ON CONFLICT(instance_id, run_key) DO UPDATE SET summaries = summaries + excluded.summaries, reads = reads + excluded.reads, body_chars = body_chars + excluded.body_chars, updated_at = datetime('now')`,
	)
		.bind(instanceId, runKey, spend.summaries ?? 0, spend.reads ?? 0, spend.bodyChars ?? 0)
		.run();
}

/** Which of `ids` this instance has already handled on the connection. */
export async function handledAmong(env: Env, instanceId: string, endpoint: string, accountId: string, ids: readonly string[]): Promise<Set<string>> {
	const handled = new Set<string>();
	// D1 binds at most 100 variables per statement; ids come from a page of at most a few dozen, but stay inside the bound anyway.
	for (let i = 0; i < ids.length; i += 50) {
		const chunk = ids.slice(i, i + 50);
		if (!chunk.length) continue;
		const marks = chunk.map((_, n) => `?${n + 4}`).join(",");
		const res = await env.DB.prepare(`SELECT message_id FROM email_worker_handled WHERE instance_id = ?1 AND endpoint = ?2 AND account_id = ?3 AND message_id IN (${marks})`)
			.bind(instanceId, endpoint, accountId, ...chunk)
			.all<{ message_id: string }>();
		for (const r of res.results ?? []) handled.add(r.message_id);
	}
	return handled;
}

export async function markHandled(env: Env, instanceId: string, endpoint: string, accountId: string, messageId: string, how: "read" | "reply"): Promise<void> {
	await env.DB.prepare("INSERT INTO email_worker_handled (instance_id, endpoint, account_id, message_id, how) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(instance_id, endpoint, account_id, message_id) DO UPDATE SET how = CASE WHEN excluded.how = 'reply' THEN 'reply' ELSE how END")
		.bind(instanceId, endpoint, accountId, messageId, how)
		.run();
}
