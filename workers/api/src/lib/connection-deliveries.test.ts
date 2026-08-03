import { describe, expect, it } from "vitest";
import {
	backoffSeconds,
	canRetry,
	idempotencyKey,
	listDeliveries,
	markAttemptFailed,
	markDelivered,
	MAX_ATTEMPTS,
	parseJsonColumn,
	replayDelivery,
	dueDeliveries,
} from "./connection-deliveries.js";
import type { Env } from "../types.js";

/** D1 stub capturing writes and serving a seeded result set. */
function buildEnv(rows: unknown[] = [], changes = 1) {
	const writes: Array<{ sql: string; args: unknown[] }> = [];
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async first() {
							return rows[0] ?? null;
						},
						async all() {
							return { results: rows };
						},
						async run() {
							writes.push({ sql, args });
							return { meta: { changes } };
						},
					};
				},
			};
		},
	};
	return { env: { DB } as unknown as Env, writes };
}

describe("backoffSeconds", () => {
	it("spreads retries across minutes-to-hours, not milliseconds", () => {
		// These retries wait out someone else's outage (a builder MCP, a model provider),
		// which resolves in minutes-to-hours. Tight retries would burn every attempt before
		// the dependency is back.
		expect(backoffSeconds(1)).toBe(60);
		expect(backoffSeconds(2)).toBe(300);
		expect(backoffSeconds(5)).toBe(10800);
		expect(backoffSeconds(1) < backoffSeconds(2)).toBe(true);
	});

	it("clamps out-of-range attempts rather than returning undefined", () => {
		expect(backoffSeconds(0)).toBe(60);
		expect(backoffSeconds(99)).toBe(10800);
	});
});

describe("canRetry", () => {
	it("allows attempts up to the cap, then stops", () => {
		expect(canRetry(0)).toBe(true);
		expect(canRetry(MAX_ATTEMPTS - 1)).toBe(true);
		expect(canRetry(MAX_ATTEMPTS)).toBe(false);
	});
});

describe("idempotencyKey", () => {
	it("is stable for the same (connection, run, payload)", () => {
		const a = idempotencyKey("c1", "run-1", { place_id: "p1", name: "X" });
		const b = idempotencyKey("c1", "run-1", { place_id: "p1", name: "X" });
		expect(a).toBe(b);
	});

	it("ignores key ORDER — the same record built differently is the same record", () => {
		const a = idempotencyKey("c1", "run-1", { place_id: "p1", name: "X" });
		const b = idempotencyKey("c1", "run-1", { name: "X", place_id: "p1" });
		expect(a).toBe(b);
	});

	it("differs per connection, so two consumers each get the event", () => {
		expect(idempotencyKey("c1", "run-1", { a: 1 })).not.toBe(idempotencyKey("c2", "run-1", { a: 1 }));
	});

	it("differs per RUN — a deliberate re-run is a new intent, not a suppressed duplicate", () => {
		expect(idempotencyKey("c1", "run-1", { a: 1 })).not.toBe(idempotencyKey("c1", "run-2", { a: 1 }));
	});

	it("differs when the payload changes (drafted → live is a new fact)", () => {
		expect(idempotencyKey("c1", "run-1", { s: "drafted" })).not.toBe(idempotencyKey("c1", "run-1", { s: "live" }));
	});

	it("handles nested objects and arrays deterministically", () => {
		const a = idempotencyKey("c1", "r", { x: { b: 1, a: [1, 2] } });
		const b = idempotencyKey("c1", "r", { x: { a: [1, 2], b: 1 } });
		expect(a).toBe(b);
	});

	it("falls back to the payload alone when there is no run id", () => {
		expect(idempotencyKey("c1", null, { a: 1 })).toBe(idempotencyKey("c1", undefined, { a: 1 }));
	});
});

describe("markAttemptFailed", () => {
	const NOW = new Date("2026-08-03T10:00:00.000Z");

	it("schedules the next attempt with backoff while attempts remain", async () => {
		const { env, writes } = buildEnv();
		expect(await markAttemptFailed(env, "d1", 0, "boom", NOW)).toBe("retrying");
		const w = writes[0];
		expect(w.sql).toContain("SET status = 'pending'");
		expect(w.args[1]).toBe(1); // attempts incremented
		expect(w.args[2]).toBe(new Date(NOW.getTime() + 60_000).toISOString()); // +1m
	});

	it("uses a longer backoff for a later attempt", async () => {
		const { env, writes } = buildEnv();
		await markAttemptFailed(env, "d1", 1, "boom", NOW);
		expect(writes[0].args[2]).toBe(new Date(NOW.getTime() + 300_000).toISOString()); // +5m
	});

	it("dead-letters once the attempts are spent — visible, never silent", async () => {
		const { env, writes } = buildEnv();
		expect(await markAttemptFailed(env, "d1", MAX_ATTEMPTS - 1, "still down", NOW)).toBe("dead");
		expect(writes[0].sql).toContain("SET status = 'dead'");
		// The dead branch binds (id, attempts, error, now) — one fewer than the retry branch,
		// which also carries next_attempt_at.
		expect(writes[0].args[2]).toBe("still down"); // the reason is kept for the human
	});

	it("truncates a huge error rather than storing it whole", async () => {
		const { env, writes } = buildEnv();
		await markAttemptFailed(env, "d1", 0, "x".repeat(5000), NOW);
		expect(String(writes[0].args[3]).length).toBe(2000);
	});
});

describe("markDelivered", () => {
	it("clears the retry schedule and the last error", async () => {
		const { env, writes } = buildEnv();
		await markDelivered(env, "d1");
		expect(writes[0].sql).toContain("status = 'delivered'");
		expect(writes[0].sql).toContain("next_attempt_at = NULL");
		expect(writes[0].sql).toContain("last_error = NULL");
	});
});

describe("dueDeliveries", () => {
	it("asks only for pending work that is due", async () => {
		const { env } = buildEnv([{ id: "d1" }]);
		const rows = await dueDeliveries(env, new Date("2026-08-03T10:00:00.000Z"), 10);
		expect(rows).toHaveLength(1);
	});
});

describe("replayDelivery", () => {
	it("re-arms a dead delivery with a clean slate", async () => {
		const { env, writes } = buildEnv([], 1);
		expect(await replayDelivery(env, "u1", "d1")).toBe(true);
		expect(writes[0].sql).toContain("status = 'pending'");
		expect(writes[0].sql).toContain("attempts = 0");
		expect(writes[0].sql).toContain("status = 'dead'"); // only a DEAD one may be replayed
	});

	it("reports false when nothing was re-armed", async () => {
		const { env } = buildEnv([], 0);
		expect(await replayDelivery(env, "u1", "d1")).toBe(false);
	});
});

describe("listDeliveries", () => {
	it("clamps the limit to a sane page", async () => {
		const { env } = buildEnv([{ id: "d1" }]);
		expect(await listDeliveries(env, "u1", { limit: 99999 })).toHaveLength(1);
		expect(await listDeliveries(env, "u1", { status: "dead" })).toHaveLength(1);
	});
});

describe("parseJsonColumn", () => {
	it("returns {} for null, malformed, or non-object JSON", () => {
		expect(parseJsonColumn(null)).toEqual({});
		expect(parseJsonColumn("{not json")).toEqual({});
		expect(parseJsonColumn("[1,2]")).toEqual({});
		expect(parseJsonColumn('{"a":1}')).toEqual({ a: 1 });
	});
});
