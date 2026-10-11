/**
 * `GET`/`PUT /v1/instances/:id/controller-ai` (#907) on the real migrated schema.
 *
 * Invariants protected: the effective values are the documented defaults until the owner overrides
 * them; a value outside the bounds is refused (400), never silently clamped; `null` returns a key to
 * its default; and what is stored is exactly what the controllers read.
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

const { controllerAiSettingsRoutes } = await import("./controller-ai-settings.js");
const { readControllerAiPolicy } = await import("../lib/controller-ai-recovery.js");

let d1: RealSchemaD1;
let env: Env;
beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

async function call(method: string, body?: unknown) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", controllerAiSettingsRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request("/v1/instances/i1/controller-ai", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
	return { status: res.status, body: (await res.json()) as { effective: Record<string, number>; overrides: Record<string, number>; error?: string } };
}

describe("controller AI recovery settings (#907)", () => {
	it("starts at the documented defaults", async () => {
		const { body } = await call("GET");
		expect(body.effective).toEqual({ preContentSeconds: 60, silenceSeconds: 45, decisionCeilingSeconds: 240 });
		expect(body.overrides).toEqual({});
	});

	it("stores a valid override, which is exactly what the controllers read", async () => {
		const res = await call("PUT", { preContentSeconds: 120, decisionCeilingSeconds: 300 });
		expect(res.status).toBe(200);
		expect(res.body.effective).toEqual({ preContentSeconds: 120, silenceSeconds: 45, decisionCeilingSeconds: 300 });
		expect(await readControllerAiPolicy(env, "i1", "u1")).toMatchObject({ preContentMs: 120_000, silenceMs: 45_000, ceilingMs: 300_000 });
	});

	it("refuses an out-of-range value and stores nothing", async () => {
		const res = await call("PUT", { silenceSeconds: 5 });
		expect(res.status).toBe(400);
		expect(res.body.error).toContain("15 to 120");
		expect((await call("GET")).body.overrides).toEqual({});
	});

	it("null returns a key to its default", async () => {
		await call("PUT", { silenceSeconds: 90 });
		const res = await call("PUT", { silenceSeconds: null });
		expect(res.body.effective.silenceSeconds).toBe(45);
		expect(res.body.overrides).toEqual({});
	});
});
