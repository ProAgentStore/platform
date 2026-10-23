/** #1318 — the per-instance opt-out and the account default, as the owner sets and reads them. */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { parseAccountPreferences, sanitizeCodingPreferences } from "../lib/preferences.js";
import { autoResumeEnabled } from "../lib/credit-auto-resume.js";
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
	seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

const app = () => {
	const a = new Hono<{ Bindings: Env }>();
	a.route("/v1/instances", toolRoutes);
	a.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	return a;
};
const get = async () => (await app().request("/v1/instances/coder/auto-resume-on-credit", {}, env)).json();
const put = (body: unknown) => app().request("/v1/instances/coder/auto-resume-on-credit", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);

describe("the per-instance opt-out", () => {
	it("defaults to following the account (null), opts out, states the default, and returns to following", async () => {
		expect(await get()).toEqual({ instanceId: "coder", enabled: null });
		expect(await autoResumeEnabled(env, "u1", "coder")).toBe(true);
		expect((await put({ enabled: false })).status).toBe(200);
		expect(await get()).toEqual({ instanceId: "coder", enabled: false });
		expect(await autoResumeEnabled(env, "u1", "coder")).toBe(false);
		await put({ enabled: true });
		expect(await autoResumeEnabled(env, "u1", "coder")).toBe(true);
		await put({ enabled: null });
		expect(await get()).toEqual({ instanceId: "coder", enabled: null });
	});
	it("does not disturb the instance's other settings, and refuses anything that is not true, false or null", async () => {
		d1.exec(`UPDATE agent_instances SET config = '{"disabledTools":["x"]}' WHERE id = 'coder'`);
		await put({ enabled: false });
		expect(JSON.parse((d1.sqlite.prepare("SELECT config FROM agent_instances WHERE id = 'coder'").get() as { config: string }).config)).toEqual({ disabledTools: ["x"], autoResumeOnCredit: false });
		for (const bad of [{ enabled: "no" }, {}, { enabled: 0 }]) expect((await put(bad)).status).toBe(400);
	});
	it("is the owner's: another account's instance is not found", async () => {
		d1.exec("INSERT INTO users (id, github_login) VALUES ('u2', 'u2')");
		d1.exec("INSERT INTO agent_instances (id, agent_id, user_id) VALUES ('theirs', 'agent-1', 'u2')");
		expect((await app().request("/v1/instances/theirs/auto-resume-on-credit", {}, env)).status).toBeGreaterThanOrEqual(400);
	});
});

describe("the account default (coding.autoResumeOnCredit)", () => {
	it("is on unless the account turned it off; null returns it to on; the engine choice is untouched", () => {
		expect(sanitizeCodingPreferences({})).toEqual({});
		expect(sanitizeCodingPreferences({ autoResumeOnCredit: false })).toEqual({ autoResumeOnCredit: false });
		expect(sanitizeCodingPreferences({ defaultEngineId: "codex" }, { autoResumeOnCredit: false })).toEqual({ defaultEngineId: "codex", autoResumeOnCredit: false });
		expect(sanitizeCodingPreferences({ autoResumeOnCredit: null }, { autoResumeOnCredit: false })).toEqual({});
		expect(sanitizeCodingPreferences({ autoResumeOnCredit: "yes" }, { autoResumeOnCredit: false })).toEqual({ autoResumeOnCredit: false });
		expect(parseAccountPreferences('{"coding":{"autoResumeOnCredit":false}}').coding).toEqual({ autoResumeOnCredit: false });
	});
});
