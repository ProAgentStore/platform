import { beforeEach, describe, expect, it } from "vitest";
import {
	funnelDay,
	readFunnelCounts,
	recordFunnelEvent,
	resetFunnelReportingForTests,
	shouldCountView,
} from "./store-funnel.js";
import type { Env } from "../types.js";

/**
 * Unit tests for the public store funnel (#383). The counters this covers were BOTH
 * structurally zero before it — one written by nothing, one written by a statement that
 * could not succeed — so the tests worth having are the ones that fail if either of those
 * states comes back: a write that happens, and a failure that is REPORTED rather than
 * swallowed.
 */

interface Write {
	sql: string;
	args: unknown[];
}

/** A D1 double that records writes and can be told to make one class of statement throw. */
function fakeDb(opts: { failOn?: string; rows?: Array<{ event: string; total: number }> } = {}) {
	const writes: Write[] = [];
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async run() {
							if (opts.failOn && sql.includes(opts.failOn)) {
								throw new Error("FOREIGN KEY constraint failed");
							}
							writes.push({ sql, args });
							return { meta: { changes: 1 } };
						},
						async all() {
							return { results: opts.rows ?? [] };
						},
						async first() {
							return null;
						},
					};
				},
			};
		},
	};
	return { env: { DB } as unknown as Env, writes };
}

beforeEach(() => {
	resetFunnelReportingForTests();
});

describe("funnelDay", () => {
	it("buckets by UTC date, not local date", () => {
		// 23:30 UTC belongs to that UTC day even from a machine hours ahead of it.
		expect(funnelDay(new Date("2026-08-08T23:30:00Z"))).toBe("2026-08-08");
		expect(funnelDay(new Date("2026-08-09T00:05:00Z"))).toBe("2026-08-09");
	});
});

describe("shouldCountView", () => {
	it("counts a real browser", () => {
		expect(
			shouldCountView(
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
			),
		).toBe(true);
		expect(shouldCountView("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605.1.15")).toBe(true);
	});

	it("does not count self-identifying crawlers, previewers and monitors", () => {
		for (const ua of [
			"Googlebot/2.1 (+http://www.google.com/bot.html)",
			"Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
			"Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
			"facebookexternalhit/1.1",
			"Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/128.0.0.0",
			"Chrome-Lighthouse",
			"Better Uptime Monitor",
		]) {
			expect(shouldCountView(ua), ua).toBe(false);
		}
	});

	it("does not count scripted clients, including one with no User-Agent at all", () => {
		for (const ua of ["curl/8.4.0", "Wget/1.21", "python-requests/2.31.0", "node-fetch/1.0", "axios/1.7.2"]) {
			expect(shouldCountView(ua), ua).toBe(false);
		}
		// Every browser sends a UA; a caller that omits one is a script.
		expect(shouldCountView(undefined)).toBe(false);
		expect(shouldCountView(null)).toBe(false);
		expect(shouldCountView("   ")).toBe(false);
	});
});

describe("recordFunnelEvent", () => {
	it("upserts into (agent, day, event) so a second hit increments rather than duplicating", async () => {
		const { env, writes } = fakeDb();
		const now = new Date("2026-08-08T10:00:00Z");
		expect(await recordFunnelEvent(env, "a1", "view", { now })).toBe(true);
		expect(await recordFunnelEvent(env, "a1", "view", { now })).toBe(true);
		expect(writes).toHaveLength(2);
		for (const w of writes) {
			expect(w.sql).toContain("INSERT INTO agent_funnel_daily");
			expect(w.sql).toContain("ON CONFLICT(agent_id, day, event) DO UPDATE SET hits = hits + 1");
			expect(w.args).toEqual(["a1", "2026-08-08", "view"]);
		}
	});

	it("writes trial_start — the counter nothing in the codebase used to produce", async () => {
		const { env, writes } = fakeDb();
		expect(await recordFunnelEvent(env, "a1", "trial_start", { now: new Date("2026-08-08T10:00:00Z") })).toBe(true);
		expect(writes[0].args).toEqual(["a1", "2026-08-08", "trial_start"]);
	});

	it("does not bind a user id — an anonymous view has no user, and the FK on `usage` is why", async () => {
		const { env, writes } = fakeDb();
		await recordFunnelEvent(env, "a1", "view");
		expect(writes[0].sql).not.toContain("user_id");
		expect(writes[0].args).toHaveLength(3);
	});
});

describe("recordFunnelEvent — the failure path REPORTS", () => {
	it("writes the reason to error_log instead of swallowing it, and never throws", async () => {
		const { env, writes } = fakeDb({ failOn: "INTO agent_funnel_daily" });
		// The whole bug: this returned void and threw the reason away inside a waitUntil.
		await expect(recordFunnelEvent(env, "a1", "view")).resolves.toBe(false);
		const logged = writes.find((w) => w.sql.includes("INSERT INTO error_log"));
		expect(logged, "a failed funnel write must reach the durable error log").toBeTruthy();
		expect(String(logged?.args[2])).toBe("store-funnel");
		expect(String(logged?.args[4])).toContain("FOREIGN KEY constraint failed");
		expect(String(logged?.args[4])).toContain("view");
	});

	it("logs no user id — a cookieless counter must not become PII on its error path", async () => {
		const { env, writes } = fakeDb({ failOn: "INTO agent_funnel_daily" });
		await recordFunnelEvent(env, "a1", "view");
		const logged = writes.find((w) => w.sql.includes("INSERT INTO error_log"));
		expect(logged?.args[1]).toBeNull();
	});

	it("latches to one report per isolate, so a broken counter can't be amplified into a log flood", async () => {
		const { env, writes } = fakeDb({ failOn: "INTO agent_funnel_daily" });
		for (let i = 0; i < 25; i++) await recordFunnelEvent(env, "a1", "view");
		const logs = writes.filter((w) => w.sql.includes("INSERT INTO error_log"));
		expect(logs).toHaveLength(1);
		// A different event is a different signature — its first failure still surfaces.
		await recordFunnelEvent(env, "a1", "trial_start");
		expect(writes.filter((w) => w.sql.includes("INSERT INTO error_log"))).toHaveLength(2);
	});
});

describe("readFunnelCounts", () => {
	it("sums the daily buckets into views + trials", async () => {
		const { env } = fakeDb({
			rows: [
				{ event: "view", total: 42 },
				{ event: "trial_start", total: 7 },
			],
		});
		expect(await readFunnelCounts(env, "a1")).toEqual({ views: 42, trials: 7 });
	});

	it("reports zero only when there genuinely are no rows", async () => {
		const { env } = fakeDb({ rows: [] });
		expect(await readFunnelCounts(env, "a1")).toEqual({ views: 0, trials: 0 });
	});

	it("propagates a read failure rather than dressing it up as zero", async () => {
		const env = {
			DB: {
				prepare() {
					return {
						bind() {
							return {
								async all() {
									throw new Error("no such table: agent_funnel_daily");
								},
							};
						},
					};
				},
			},
		} as unknown as Env;
		// A swallowed read would put "0 views" on the page, which is the same class of lie the
		// issue is about: a surface reporting a number nothing behind it produced.
		await expect(readFunnelCounts(env, "a1")).rejects.toThrow(/no such table/);
	});
});
