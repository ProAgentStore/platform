/**
 * The public store funnel (#383) — views → trials, counted off the unauthenticated
 * storefront routes and read back by `GET /v1/agents/:id/analytics`.
 *
 * Both counters used to be structurally zero: `trial_start` was written by nothing at all,
 * and `view` was an INSERT into `usage` that violated `user_id REFERENCES users(id)` on
 * every request, inside a `.catch(() => {})` in a `waitUntil` — thrown away after the
 * response had been sent. See migration 0095 for why the fix is a table rather than a
 * nullable column.
 *
 * The counter matters more than its size suggests: it is the only thing that separates
 * "nobody wants this agent" from "nobody found it", and those imply opposite actions. A
 * catalog audit that cannot tell them apart falls back to subscriptions and token spend,
 * which on this account are almost entirely the owner's own traffic.
 */
import type { Env } from "../types.js";
import { logError } from "./error-log.js";

/**
 * What the public storefront produces.
 *
 * `subscribe` is deliberately NOT here — it is an authenticated action by a known user and
 * stays in `usage`, which is the table that records who did what.
 */
export type FunnelEvent = "view" | "trial_start";

export interface FunnelCounts {
	views: number;
	trials: number;
}

/** The UTC day a hit is counted into. Matches `agent_stats_daily`'s grain and D1's `date()`. */
export function funnelDay(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10);
}

/**
 * Self-identifying non-humans, by the token they put in their own User-Agent.
 *
 * Three classes, all of which would otherwise be indistinguishable from interest:
 * crawlers and previewers (`bot`, `crawl`, `spider`, `slurp`, `bingpreview`,
 * `facebookexternalhit`), uptime/perf tooling (`monitor`, `uptime`, `lighthouse`,
 * `headless`), and scripted clients (`curl`, `wget`, `python-requests`, `node-fetch`,
 * `go-http-client`, `okhttp`, `libwww`, `axios`).
 *
 * This is a filter on the SIGNAL, not a security control — a UA is caller-supplied and
 * anything determined to be counted will be. What bounds the write is the table's shape
 * (one row per agent per day per event), not this.
 */
const NON_HUMAN_UA =
	/bot\b|bots?\/|crawl|spider|slurp|scrape|monitor|uptime|preview|headless|lighthouse|curl\/|wget|python-requests|node-fetch|go-http-client|okhttp|libwww|axios|facebookexternalhit/i;

/**
 * Should this request count as a human looking at an agent page?
 *
 * A MISSING User-Agent is not counted. Every browser sends one; a caller that omits it is
 * a script, and counting scripts is how a view counter turns into a number nobody can act
 * on — which is the failure this whole issue is about, one level up.
 */
export function shouldCountView(userAgent: string | null | undefined): boolean {
	const ua = (userAgent ?? "").trim();
	if (!ua) return false;
	return !NON_HUMAN_UA.test(ua);
}

/**
 * One D1 write per counted hit, upserting into the (agent, day, event) bucket.
 *
 * ON CONFLICT rather than a read-then-write: two concurrent views of the same agent on the
 * same day are the normal case, and a read-modify-write would lose one of them.
 */
const UPSERT_SQL = `INSERT INTO agent_funnel_daily (agent_id, day, event, hits)
     VALUES (?1, ?2, ?3, 1)
     ON CONFLICT(agent_id, day, event) DO UPDATE SET hits = hits + 1`;

/**
 * Failure signatures already reported by THIS isolate.
 *
 * The bug being fixed was a swallowed error on a public route, so the obvious fix is "log
 * it instead". Done naively that trades one unbounded anonymous write for another: if the
 * funnel write is broken (which is exactly the state this issue found it in), every request
 * would then write an `error_log` row. Latching to the first occurrence per isolate keeps
 * the report — the first failure always surfaces, and a fresh isolate reports again — while
 * making the volume a property of the deployment rather than of the caller.
 */
const reportedFailures = new Set<string>();

/** Clear the per-isolate report latch. Tests only — an isolate never wants this. */
export function resetFunnelReportingForTests(): void {
	reportedFailures.clear();
}

/**
 * Count one funnel hit. Never throws — a counter must not break the page it counts.
 *
 * Returns whether the row was written, so a caller (and a test) can tell "recorded" from
 * "failed, and reported". The failure path is the point of the function: the previous
 * version's `.catch(() => {})` is why a foreign-key violation on every single request went
 * unnoticed from the day it shipped until an audit read the schema.
 */
export async function recordFunnelEvent(
	env: Env,
	agentId: string,
	event: FunnelEvent,
	opts: { now?: Date } = {},
): Promise<boolean> {
	try {
		await env.DB.prepare(UPSERT_SQL).bind(agentId, funnelDay(opts.now), event).run();
		return true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const signature = `${event}:${message}`;
		if (!reportedFailures.has(signature)) {
			reportedFailures.add(signature);
			// logError never throws, so this cannot turn a counter failure into a request failure.
			await logError(env, {
				source: "store-funnel",
				message: `funnel ${event} not counted: ${message}`,
				// Anonymous by construction. There is no user to attribute, and inventing one
				// (the IP, a hash of it) is what turns a cookieless counter into PII.
				userId: null,
				context: { agentId, event, latched: "first-per-isolate" },
			});
		}
		return false;
	}
}

interface FunnelRow {
	event: string;
	total: number;
}

/**
 * Total views + trial starts for one agent, all time.
 *
 * Deliberately NOT wrapped in a try/catch. Every other read in the analytics route throws
 * on failure, and a swallowed read here would put a zero on the page — which is precisely
 * the shape of bug this is fixing: a surface reporting a number that nothing behind it
 * produced. A 500 says "the number is unavailable"; a 0 says "nobody looked".
 */
export async function readFunnelCounts(env: Env, agentId: string): Promise<FunnelCounts> {
	const res = await env.DB.prepare(
		`SELECT event, COALESCE(SUM(hits), 0) AS total FROM agent_funnel_daily
     WHERE agent_id = ?1 GROUP BY event`,
	)
		.bind(agentId)
		.all<FunnelRow>();
	const counts: FunnelCounts = { views: 0, trials: 0 };
	for (const row of res.results ?? []) {
		if (row.event === "view") counts.views = Math.max(0, Number(row.total) || 0);
		else if (row.event === "trial_start") counts.trials = Math.max(0, Number(row.total) || 0);
	}
	return counts;
}
