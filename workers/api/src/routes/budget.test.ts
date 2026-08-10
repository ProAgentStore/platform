/**
 * Tests for GET/PUT /v1/budget/limits.
 *
 * What the route guarantees:
 *   – GET returns effective ceilings + 24h consumption + remaining + tier source
 *   – PUT clamps values to MAX_OVERRIDE_* and upserts the per-account row
 *   – NULL on PUT clears the override (inherit from next tier)
 *   – The resolved effective value reflects the write immediately
 *   – Owner scoping: the row is keyed to the caller's uid, not any caller-supplied id
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { budgetRoutes } from "./budget.js";
import type { Env } from "../types.js";

const TEST_SECRET = "test-secret";

const DAILY_CEILING_MICROS = 50_000_000; // $50
const DAILY_TOKEN_CEILING = 250_000_000; // 250M tokens
const MAX_CHARGED_MICROS = 10_000_000_000;
const MAX_TOKEN_CEILING = 100_000_000_000;

type RowStore = Map<string, { token_ceiling: number | null; charged_micros_ceiling: number | null }>;

/**
 * Build a test app backed by an in-memory row store for account_budget_limits and
 * ai_usage (always zero consumption unless overridden).
 */
function testApp(opts: {
	rows?: RowStore;
	consumedCharged?: number;
	consumedTokens?: number;
} = {}) {
	const rows: RowStore = opts.rows ?? new Map();
	const charged = opts.consumedCharged ?? 0;
	const tokens = opts.consumedTokens ?? 0;

	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/budget", budgetRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});

	const env = {
		SESSION_SIGNING_KEY: TEST_SECRET,
		// No env-var overrides by default → falls through to hard constants.
		ACCOUNT_DAILY_CHARGED_MICROS_CEILING: undefined,
		ACCOUNT_DAILY_TOKEN_CEILING: undefined,
		DB: {
			prepare(sql: string) {
				const s = sql.trim();
				return {
					bind(...args: unknown[]) {
						return {
							async all() {
								// SELECT for account_budget_limits — returns the user row + platform row (if present).
								if (s.startsWith("SELECT") && s.includes("account_budget_limits")) {
									const uid = String(args[0]);
									const results: Array<{ user_id: string; token_ceiling: number | null; charged_micros_ceiling: number | null }> = [];
									const userRow = rows.get(uid);
									if (userRow) results.push({ user_id: uid, ...userRow });
									const platRow = rows.get("__platform__");
									if (platRow) results.push({ user_id: "__platform__", ...platRow });
									return { results };
								}
								// ai_usage aggregation for accountUsageSince
								if (s.startsWith("SELECT") && s.includes("ai_usage")) {
									return { results: [{ charged_micros: charged, tokens }] };
								}
								return { results: [] };
							},
							async first() {
								// ai_usage aggregation (single-row variant used in accountUsageSince).
								if (s.includes("ai_usage")) {
									return { charged_micros: charged, tokens };
								}
								return null;
							},
							async run() {
								// DELETE — clear the user's row.
								if (s.startsWith("DELETE") && s.includes("account_budget_limits")) {
									const uid = String(args[0]);
									rows.delete(uid);
									return { success: true };
								}
								// INSERT OR REPLACE / ON CONFLICT.
								if (s.startsWith("INSERT") && s.includes("account_budget_limits")) {
									const uid = String(args[0]);
									rows.set(uid, {
										token_ceiling: args[1] as number | null,
										charged_micros_ceiling: args[2] as number | null,
									});
									return { success: true };
								}
								return { success: true };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;

	return { app, env, rows };
}

async function req(
	app: Hono<{ Bindings: Env }>,
	env: Env,
	method: "GET" | "PUT",
	body?: unknown,
	uid = "user-1",
) {
	const token = await signSession(uid, TEST_SECRET);
	const init: RequestInit = {
		method,
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
	};
	if (body !== undefined) init.body = JSON.stringify(body);
	return app.request("/v1/budget/limits", init, env);
}

// ─── GET ───────────────────────────────────────────────────────────────────

describe("GET /v1/budget/limits", () => {
	it("returns hard-constant defaults when no rows exist", async () => {
		const { app, env } = testApp();
		const res = await req(app, env, "GET");
		expect(res.status).toBe(200);
		const data = await res.json<{
			stored: { chargedMicrosCeiling: number | null; tokenCeiling: number | null };
			effective: { chargedMicrosCeiling: number; chargedMicrosCeilingTier: string; tokenCeiling: number; tokenCeilingTier: string };
			consumption: { chargedMicros: number; tokens: number };
			remaining: { chargedMicros: number; tokens: number };
		}>();
		expect(data.stored.chargedMicrosCeiling).toBeNull();
		expect(data.stored.tokenCeiling).toBeNull();
		expect(data.effective.chargedMicrosCeiling).toBe(DAILY_CEILING_MICROS);
		expect(data.effective.chargedMicrosCeilingTier).toBe("default");
		expect(data.effective.tokenCeiling).toBe(DAILY_TOKEN_CEILING);
		expect(data.effective.tokenCeilingTier).toBe("default");
		expect(data.consumption.chargedMicros).toBe(0);
		expect(data.consumption.tokens).toBe(0);
		expect(data.remaining.chargedMicros).toBe(DAILY_CEILING_MICROS);
		expect(data.remaining.tokens).toBe(DAILY_TOKEN_CEILING);
	});

	it("reports tier 'account' when the caller has a per-account row", async () => {
		const rows: RowStore = new Map([["user-1", { charged_micros_ceiling: 100_000_000, token_ceiling: 500_000_000 }]]);
		const { app, env } = testApp({ rows });
		const res = await req(app, env, "GET");
		const data = await res.json<{ effective: { chargedMicrosCeilingTier: string; tokenCeilingTier: string; chargedMicrosCeiling: number; tokenCeiling: number } }>();
		expect(data.effective.chargedMicrosCeilingTier).toBe("account");
		expect(data.effective.tokenCeilingTier).toBe("account");
		expect(data.effective.chargedMicrosCeiling).toBe(100_000_000);
		expect(data.effective.tokenCeiling).toBe(500_000_000);
	});

	it("reports tier 'platform' when only the platform row exists", async () => {
		const rows: RowStore = new Map([["__platform__", { charged_micros_ceiling: 200_000_000, token_ceiling: null }]]);
		const { app, env } = testApp({ rows });
		const res = await req(app, env, "GET");
		const data = await res.json<{ effective: { chargedMicrosCeilingTier: string; tokenCeilingTier: string } }>();
		expect(data.effective.chargedMicrosCeilingTier).toBe("platform");
		// Token falls through to default since platform row has null token_ceiling.
		expect(data.effective.tokenCeilingTier).toBe("default");
	});

	it("reflects current 24h consumption and computes remaining", async () => {
		const { app, env } = testApp({ consumedCharged: 20_000_000, consumedTokens: 80_000_000 });
		const res = await req(app, env, "GET");
		const data = await res.json<{
			consumption: { chargedMicros: number; tokens: number };
			remaining: { chargedMicros: number; tokens: number };
		}>();
		expect(data.consumption.chargedMicros).toBe(20_000_000);
		expect(data.consumption.tokens).toBe(80_000_000);
		expect(data.remaining.chargedMicros).toBe(DAILY_CEILING_MICROS - 20_000_000);
		expect(data.remaining.tokens).toBe(DAILY_TOKEN_CEILING - 80_000_000);
	});

	it("clamps remaining to 0 when consumption exceeds the ceiling", async () => {
		const { app, env } = testApp({ consumedCharged: 60_000_000, consumedTokens: 300_000_000 });
		const res = await req(app, env, "GET");
		const data = await res.json<{ remaining: { chargedMicros: number; tokens: number } }>();
		expect(data.remaining.chargedMicros).toBe(0);
		expect(data.remaining.tokens).toBe(0);
	});

	it("requires auth", async () => {
		const { app, env } = testApp();
		const res = await app.request("/v1/budget/limits", {}, env);
		expect(res.status).toBe(401);
	});

	it("is owner-scoped (user-2's row does not appear for user-1)", async () => {
		const rows: RowStore = new Map([["user-2", { charged_micros_ceiling: 999_000_000, token_ceiling: null }]]);
		const { app, env } = testApp({ rows });
		const res = await req(app, env, "GET", undefined, "user-1");
		const data = await res.json<{ effective: { chargedMicrosCeilingTier: string } }>();
		// user-1 has no row, so effective falls through to default.
		expect(data.effective.chargedMicrosCeilingTier).toBe("default");
	});
});

// ─── PUT ───────────────────────────────────────────────────────────────────

describe("PUT /v1/budget/limits", () => {
	it("upserts the per-account row and returns re-resolved effective values", async () => {
		const { app, env, rows } = testApp();
		const res = await req(app, env, "PUT", { chargedMicrosCeiling: 100_000_000, tokenCeiling: 500_000_000 });
		expect(res.status).toBe(200);
		const data = await res.json<{
			stored: { chargedMicrosCeiling: number; tokenCeiling: number };
			effective: { chargedMicrosCeiling: number; chargedMicrosCeilingTier: string; tokenCeiling: number; tokenCeilingTier: string };
		}>();
		expect(data.stored.chargedMicrosCeiling).toBe(100_000_000);
		expect(data.stored.tokenCeiling).toBe(500_000_000);
		expect(data.effective.chargedMicrosCeiling).toBe(100_000_000);
		expect(data.effective.chargedMicrosCeilingTier).toBe("account");
		expect(data.effective.tokenCeiling).toBe(500_000_000);
		expect(data.effective.tokenCeilingTier).toBe("account");
		// The row was actually stored.
		expect(rows.get("user-1")?.charged_micros_ceiling).toBe(100_000_000);
	});

	it("clamps to MAX_OVERRIDE values, not unbounded", async () => {
		const { app, env, rows } = testApp();
		const res = await req(app, env, "PUT", {
			chargedMicrosCeiling: MAX_CHARGED_MICROS + 1_000_000,
			tokenCeiling: MAX_TOKEN_CEILING + 1_000_000,
		});
		expect(res.status).toBe(200);
		const data = await res.json<{ stored: { chargedMicrosCeiling: number; tokenCeiling: number } }>();
		expect(data.stored.chargedMicrosCeiling).toBe(MAX_CHARGED_MICROS);
		expect(data.stored.tokenCeiling).toBe(MAX_TOKEN_CEILING);
		expect(rows.get("user-1")?.charged_micros_ceiling).toBe(MAX_CHARGED_MICROS);
	});

	it("null on both fields deletes the per-account row (inherits)", async () => {
		const rows: RowStore = new Map([["user-1", { charged_micros_ceiling: 100_000_000, token_ceiling: 500_000_000 }]]);
		const { app, env } = testApp({ rows });
		const res = await req(app, env, "PUT", { chargedMicrosCeiling: null, tokenCeiling: null });
		expect(res.status).toBe(200);
		// Row deleted — inheriting from default.
		expect(rows.has("user-1")).toBe(false);
		const data = await res.json<{ stored: { chargedMicrosCeiling: null; tokenCeiling: null }; effective: { chargedMicrosCeilingTier: string } }>();
		expect(data.stored.chargedMicrosCeiling).toBeNull();
		expect(data.effective.chargedMicrosCeilingTier).toBe("default");
	});

	it("null on one field stores NULL for that field (partial inherit)", async () => {
		const { app, env, rows } = testApp();
		const res = await req(app, env, "PUT", { chargedMicrosCeiling: 75_000_000, tokenCeiling: null });
		expect(res.status).toBe(200);
		expect(rows.get("user-1")?.charged_micros_ceiling).toBe(75_000_000);
		expect(rows.get("user-1")?.token_ceiling).toBeNull();
		const data = await res.json<{ effective: { chargedMicrosCeilingTier: string; tokenCeilingTier: string } }>();
		expect(data.effective.chargedMicrosCeilingTier).toBe("account");
		expect(data.effective.tokenCeilingTier).toBe("default");
	});

	it("rejects negative values", async () => {
		const { app, env } = testApp();
		const res = await req(app, env, "PUT", { chargedMicrosCeiling: -1 });
		expect(res.status).toBe(400);
	});

	it("rejects non-numeric values", async () => {
		const { app, env } = testApp();
		const res = await req(app, env, "PUT", { chargedMicrosCeiling: "banana" });
		expect(res.status).toBe(400);
	});

	it("rejects missing JSON body", async () => {
		const { app, env } = testApp();
		const token = await signSession("user-1", TEST_SECRET);
		const res = await app.request("/v1/budget/limits", {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: "not json",
		}, env);
		expect(res.status).toBe(400);
	});

	it("requires auth", async () => {
		const { app, env } = testApp();
		const res = await app.request("/v1/budget/limits", { method: "PUT", body: "{}" }, env);
		expect(res.status).toBe(401);
	});

	it("is owner-scoped — writes to the caller uid not any other", async () => {
		const { app, env, rows } = testApp();
		// user-1 writes their ceiling.
		await req(app, env, "PUT", { chargedMicrosCeiling: 55_000_000 }, "user-1");
		// user-2 is unaffected.
		expect(rows.has("user-2")).toBe(false);
		expect(rows.get("user-1")?.charged_micros_ceiling).toBe(55_000_000);
	});
});
