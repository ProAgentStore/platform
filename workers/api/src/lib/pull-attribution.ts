/**
 * Which pull request came from which agent run (#401).
 *
 * "The console can show them the issue that started the work and the build that ran, but not the
 * PR that is the actual output" — and the half of that which no GitHub call can answer is
 * *whether my agent opened it*. GitHub knows the PR's author; it does not know that the author was
 * a CLI a Pilot was driving on your laptop.
 *
 * The platform already records it. `lib/engine-acts.ts` writes a `pr.open` / `pr.merge`
 * consequential act into `agent_events` (migration 0038) with the run or session as `trace_id`.
 * This reads those back and matches them to PR numbers, so a row can say "opened by run …" and
 * link into the trace that produced it.
 *
 * ── ATTRIBUTION IS EXACT OR ABSENT ──
 *
 * `prRef()` in the runner extracts a number from `gh pr merge 42` and from a PR URL, and returns
 * null for the very common `gh pr create --fill` — the number only exists in the command's OUTPUT,
 * which the act classifier never sees. So a real subset of agent-opened PRs carries no number.
 *
 * They are left UNATTRIBUTED. The obvious repair — pair an unnumbered `pr.open` with whichever PR
 * was created around the same time — is a guess, and `engine-acts.ts` states the rule this file
 * follows: "the distinction between 'it merged' and 'we did not see whether it merged' is the whole
 * difference between an audit trail and a guess." A badge that is right most of the time is worse
 * than no badge, because the one time it is wrong is the time somebody is asking who did this.
 */
import type { Env } from "../types.js";

/** How far back the act scan reaches. Bounded — this runs on a panel poll. */
const ACT_SCAN_LIMIT = 200;

export interface PullAttribution {
	/** The run (or coding session) whose engine did it — `GET /trace?trace_id=` takes this. */
	traceId: string;
	/** `pr.open` or `pr.merge`. */
	act: string;
	at: string;
	/** The coding session, when the act carried one. */
	sessionId: string | null;
}

interface ActRow {
	trace_id: string | null;
	ts: number;
	context: string | null;
}

/** `#42` → 42. Anything else → null; this is the exact-or-absent rule, in one place. */
export function pullNumberFromTarget(target: unknown): number | null {
	if (typeof target !== "string") return null;
	const m = target.trim().match(/^#(\d+)$/);
	if (!m) return null;
	const n = Number.parseInt(m[1], 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Fold the raw act rows into "PR number → the run that acted on it".
 *
 * NEWEST wins: rows arrive newest-first and the first sighting of a number is kept, so a PR opened
 * by one run and later merged by another reports the most recent act rather than a stale one.
 * Pure, so the precedence is testable without D1.
 */
export function foldPullActs(rows: ActRow[]): Map<number, PullAttribution> {
	const out = new Map<number, PullAttribution>();
	for (const row of rows) {
		let ctx: Record<string, unknown>;
		try {
			ctx = JSON.parse(row.context || "{}") as Record<string, unknown>;
		} catch {
			continue;
		}
		const act = typeof ctx.act === "string" ? ctx.act : "";
		if (act !== "pr.open" && act !== "pr.merge") continue;
		const number = pullNumberFromTarget(ctx.target);
		if (number == null || out.has(number)) continue;
		out.set(number, {
			traceId: row.trace_id ?? "",
			act,
			at: new Date(row.ts || 0).toISOString(),
			sessionId: typeof ctx.sessionId === "string" ? ctx.sessionId : null,
		});
	}
	return out;
}

/**
 * The agent acts on this instance's pull requests, by PR number. Owner-scoped in SQL (both
 * `user_id` and `instance_id`), like every other read on this surface. Never throws — attribution
 * is a badge, and losing it must not fail the panel.
 */
export async function pullActsFor(env: Env, instanceId: string, userId: string): Promise<Map<number, PullAttribution>> {
	try {
		const { results } = await env.DB.prepare(
			"SELECT trace_id, ts, context FROM agent_events WHERE user_id = ?1 AND instance_id = ?2 AND event = 'act.consequential' ORDER BY ts DESC LIMIT ?3",
		)
			.bind(userId, instanceId, ACT_SCAN_LIMIT)
			.all<ActRow>();
		return foldPullActs(results ?? []);
	} catch {
		return new Map();
	}
}
