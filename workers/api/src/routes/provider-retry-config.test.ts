/**
 * #1391 — an instance's provider-retry policy: set, read back as the policy a run will actually use, cleared, and refused when malformed.
 * Real routes on the real migrated schema; nothing is faked but the sign-in.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

const { toolRoutes } = await import("./tools.js");

let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["x1"] });
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
type Json = Record<string, any>;
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
	const router = new Hono<{ Bindings: Env }>();
	router.route("/v1/instances", toolRoutes);
	router.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await router.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
	return { status: res.status, body: (await res.json()) as Json };
}
const get = () => call("GET", "/v1/instances/i1/loop-limits");
const put = (body: Json) => call("PUT", "/v1/instances/i1/loop-limits", body);

describe("the policy a run on this instance will use (#1391)", () => {
	it("with nothing set, the defaults — four waits of 2, 4, 8 and 15 minutes, ±20% — are what is reported", async () => {
		const r = await get();
		expect(r.body.limits).toEqual({});
		expect(r.body.effectiveProviderRetry).toEqual({ attempts: 4, baseMs: 120_000, maxMs: 900_000, jitter: 0.2, fallbackModel: null, scheduleMs: [120_000, 240_000, 480_000, 900_000] });
	});

	it("stores what the owner sets, merges it over the defaults, and reads it back as both the setting and the effective policy", async () => {
		const saved = await put({ providerRetry: { attempts: 5, baseMs: 30_000, jitter: 0.1 } });
		expect(saved.status).toBe(200);
		expect(saved.body.limits.providerRetry).toEqual({ attempts: 5, baseMs: 30_000, jitter: 0.1 });
		expect(saved.body.effectiveProviderRetry).toMatchObject({ attempts: 5, baseMs: 30_000, maxMs: 900_000, jitter: 0.1, scheduleMs: [30_000, 60_000, 120_000, 240_000, 480_000] });
		expect((await get()).body.effectiveProviderRetry.attempts).toBe(5);
	});

	it("an out-of-range value is brought inside its bound and the stored result says so", async () => {
		const r = await put({ providerRetry: { attempts: 500, baseMs: 1, jitter: 9 } });
		expect(r.body.limits.providerRetry).toEqual({ attempts: 8, baseMs: 5_000, jitter: 0.5 });
	});

	it("`null` returns the policy to the defaults; leaving the key out of a later call keeps it", async () => {
		await put({ providerRetry: { attempts: 2 } });
		await put({ questions: "decide" }); // speaks about something else: the retry policy stays
		expect((await get()).body.limits).toEqual({ questions: "decide", providerRetry: { attempts: 2 } });
		const cleared = await put({ providerRetry: null });
		expect(cleared.body.limits).toEqual({ questions: "decide" });
		expect(cleared.body.effectiveProviderRetry.attempts).toBe(4);
	});

	it("setting it leaves the iteration bounds and the objective cap exactly as they were", async () => {
		await put({ minIterations: 5, maxIterations: 20, maxObjectiveChars: 4000 });
		const r = await put({ providerRetry: { attempts: 3 } });
		expect(r.body.limits).toMatchObject({ minIterations: 5, maxIterations: 20, maxObjectiveChars: 4000, providerRetry: { attempts: 3 } });
	});

	it("an empty body still clears everything, the retry policy included", async () => {
		await put({ providerRetry: { attempts: 3 }, maxIterations: 9 });
		expect((await put({})).body.limits).toEqual({});
	});

	it.each([["a string", "often"], ["a number", 3], ["a list", [3]], ["a boolean", true]])("refuses %s: it is an object of numbers or null, not a quiet no-op", async (_n, providerRetry) => {
		const r = await put({ providerRetry });
		expect(r.status).toBe(400);
		expect(r.body.error).toMatch(/providerRetry must be an object/);
		expect((await get()).body.limits).toEqual({});
	});

	it("another account's instance is not found, and nothing is written to it", async () => {
		expect((await call("PUT", "/v1/instances/x1/loop-limits", { providerRetry: { attempts: 3 } })).status).toBe(404);
	});
});

describe("the fallback model (#1392)", () => {
	it("is off by default, and the effective policy says so", async () => {
		expect((await get()).body.effectiveProviderRetry.fallbackModel).toBeNull();
	});

	it("is stored when the owner names one, and read back as the setting and the effective policy", async () => {
		const r = await put({ providerRetry: { attempts: 3, fallbackModel: "gpt-5.1-codex-mini" } });
		expect(r.status).toBe(200);
		expect(r.body.limits.providerRetry).toEqual({ attempts: 3, fallbackModel: "gpt-5.1-codex-mini" });
		expect(r.body.effectiveProviderRetry).toMatchObject({ attempts: 3, fallbackModel: "gpt-5.1-codex-mini" });
		expect((await get()).body.effectiveProviderRetry.fallbackModel).toBe("gpt-5.1-codex-mini");
	});

	it.each([["a space", "gpt 5"], ["a flag smuggled in", "gpt-5 --dangerously-skip-permissions"], ["a shell fragment", "$(id)"], ["a number", 5], ["empty", ""], ["too long", "x".repeat(101)]])("a bad model id is REFUSED (400), not quietly dropped — %s", async (_n, fallbackModel) => {
		const r = await put({ providerRetry: { attempts: 3, fallbackModel } });
		expect(r.status).toBe(400);
		expect(r.body.error).toMatch(/fallbackModel must be a model id/);
		expect((await get()).body.limits).toEqual({}); // nothing was saved
	});

	it("`fallbackModel: null` inside the object means no fallback, and saves the rest", async () => {
		const r = await put({ providerRetry: { attempts: 2, fallbackModel: null } });
		expect(r.status).toBe(200);
		expect(r.body.limits.providerRetry).toEqual({ attempts: 2 });
		expect(r.body.effectiveProviderRetry.fallbackModel).toBeNull();
	});

	it("the object REPLACES the stored policy, so changing another field without repeating the fallback turns the fallback OFF — the safe direction", async () => {
		await put({ providerRetry: { attempts: 3, fallbackModel: "gpt-x" } });
		const r = await put({ providerRetry: { attempts: 5 } });
		expect(r.body.limits.providerRetry).toEqual({ attempts: 5 });
		expect(r.body.effectiveProviderRetry.fallbackModel).toBeNull();
	});

	it("`providerRetry: null` clears the fallback with the rest; a call about something else keeps it", async () => {
		await put({ providerRetry: { fallbackModel: "gpt-x" } });
		await put({ questions: "decide" });
		expect((await get()).body.effectiveProviderRetry.fallbackModel).toBe("gpt-x");
		expect((await put({ providerRetry: null })).body.effectiveProviderRetry.fallbackModel).toBeNull();
	});
});
