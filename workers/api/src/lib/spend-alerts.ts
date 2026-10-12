/**
 * Daily spend alerts (#1040) — a push when an owner's rolling 24h CHARGED spend reaches the alert
 * they set (`account_budget_limits.spend_alert_micros`), at most once per 24h.
 *
 * An alert, not a limit: the daily ceilings stop work; this only tells the owner, early, so a
 * ceiling is never the first they hear of a costly day. It reads the same ledger window the
 * ceilings are checked against (`accountUsageSince`), so the two can never disagree about the number.
 */
import { deepLinkFor } from "./console-links.js";
import { formatUsd } from "./ai-pricing.js";
import { accountUsageSince } from "./usage.js";
import { notifyUser } from "../routes/push.js";
import type { Env } from "../types.js";

/** Accounts checked per tick — a bound on the sweep, not a product limit. */
const SWEEP_LIMIT = 200;

export async function runSpendAlerts(env: Env): Promise<number> {
	const due =
		(
			await env.DB.prepare(
				`SELECT user_id, spend_alert_micros FROM account_budget_limits
				  WHERE user_id != '__platform__' AND spend_alert_micros > 0
				    AND (spend_alert_sent_at IS NULL OR spend_alert_sent_at < datetime('now', '-24 hours'))
				  LIMIT ?1`,
			)
				.bind(SWEEP_LIMIT)
				.all<{ user_id: string; spend_alert_micros: number }>()
		).results ?? [];
	let sent = 0;
	for (const row of due) {
		const { chargedMicros } = await accountUsageSince(env, row.user_id, 24);
		if (chargedMicros < row.spend_alert_micros) continue;
		// Claim before sending, so an overlapping tick cannot send twice.
		const claimed = await env.DB.prepare(
			`UPDATE account_budget_limits SET spend_alert_sent_at = datetime('now')
			  WHERE user_id = ?1 AND (spend_alert_sent_at IS NULL OR spend_alert_sent_at < datetime('now', '-24 hours'))`,
		)
			.bind(row.user_id)
			.run();
		if (!claimed.meta?.changes) continue;
		await notifyUser(
			env,
			row.user_id,
			"spend",
			"💸 AI spend alert",
			`Your agents' charged AI spend reached ${formatUsd(chargedMicros)} in the last 24 hours (alert at ${formatUsd(row.spend_alert_micros)}). Nothing was stopped — see Usage for what is driving it.`,
			deepLinkFor({ kind: "usage" }),
			{ key: `spend-alert:${row.user_id}` },
		).catch(() => undefined);
		sent++;
	}
	return sent;
}
