/**
 * The per-instance notification policy over the REAL schema (#992).
 *
 * The pure precedence rules are asserted in `lib/notification-policy.test.ts`; what can only be
 * asserted here is the edge: that a save lands in `agent_instances.config` without disturbing the
 * keys beside it, that `effective` comes back resolved so the console never computes precedence
 * itself, that "restore inherited" really removes the override, and that none of it reaches
 * another tenant's instance.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

const { registerInstanceNotificationRoutes } = await import("./instances-notifications.js");

let d1: RealSchemaD1;
const env = () => ({ DB: d1.DB }) as unknown as Env;

function testApp() {
	const app = new Hono<{ Bindings: Env }>();
	const router = new Hono<{ Bindings: Env }>();
	registerInstanceNotificationRoutes(router);
	app.route("/v1/instances", router);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	return app;
}

async function call(method: string, path: string, body?: unknown) {
	const res = await testApp().request(
		`/v1/instances${path}`,
		{ method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
		env(),
	);
	// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const configOf = async (id: string) =>
	JSON.parse(String((await d1.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1").bind(id).first<{ config: string }>())?.config ?? "{}")) as Record<string, unknown>;

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('a1', 'u1', 't992', 'Runner', '{}')`);
	// `voice` sits beside the policy on purpose: a save must not take an unrelated key with it (#231).
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
	  ('mine', 'a1', 'u1', 'active', '{"voice":{"speed":130}}'),
	  ('theirs', 'a1', 'u2', 'active', '{}')`);
});
afterEach(() => d1.close());

describe("reading the policy", () => {
	it("starts inherited — empty rules, and the account's state shown as what it is", async () => {
		d1.DB.prepare("UPDATE users SET preferences = ?2 WHERE id = ?1").bind("u1", JSON.stringify({ notifications: { muted: ["deploy"] } })).run();
		const r = await call("GET", "/mine/notifications");
		expect(r.status).toBe(200);
		expect(r.body.rules).toEqual([]);
		expect(r.body.inherited.muted).toEqual(["deploy"]);
		// The legacy mute, restated as the rule it is equivalent to — and update-only, so it can
		// never be read as silencing an alert.
		expect(r.body.inherited.legacy).toEqual([{ type: "deploy", severity: "update", push: false }]);
		const deployUpdate = r.body.effective.find((e: { type: string; severity: string }) => e.type === "deploy" && e.severity === "update");
		expect(deployUpdate.push).toMatchObject({ allowed: false, source: "baseline" });
		const deployAlert = r.body.effective.find((e: { type: string; severity: string }) => e.type === "deploy" && e.severity === "alert");
		expect(deployAlert.push).toMatchObject({ allowed: true, source: "baseline" });
	});

	it("serves the vocabulary a write has to pick from, including the channels", async () => {
		const r = await call("GET", "/notification-vocabulary");
		expect(r.status).toBe(200);
		expect(r.body.types.map((t: { id: string }) => t.id)).toContain("ci");
		expect(r.body.events.map((e: { id: string }) => e.id)).toContain("approval_required");
		expect(r.body.channels.map((c: { id: string }) => c.id)).toEqual(["inapp", "push"]);
		expect(r.body.severities).toEqual(["update", "alert"]);
	});
});

describe("writing it", () => {
	it("saves the rules, resolves them back, and leaves the config beside them alone", async () => {
		const rules = [
			{ event: "approval_required", inapp: true, push: true },
			{ type: "apply", severity: "update", push: false },
		];
		const r = await call("PUT", "/mine/notifications", { rules });
		expect(r.status).toBe(200);
		expect(r.body.rules).toEqual(rules);
		const cfg = await configOf("mine");
		expect(cfg.notifications).toEqual({ rules });
		expect(cfg.voice, "a one-key patch, not a blob rewrite").toEqual({ speed: 130 });

		const approval = r.body.effective.find((e: { event?: string }) => e.event === "approval_required");
		expect(approval.push).toMatchObject({ allowed: true, source: "instance" });
		const applyUpdate = r.body.effective.find((e: { type: string; severity: string }) => e.type === "apply" && e.severity === "update");
		expect(applyUpdate.push).toMatchObject({ allowed: false, source: "instance" });
		// The apply ALERT was not mentioned, so it still gets through — the invariant, at the edge.
		const applyAlert = r.body.effective.find((e: { type: string; severity: string }) => e.type === "apply" && e.severity === "alert");
		expect(applyAlert.push.allowed).toBe(true);
	});

	it("`allOff` is stored as the rule it means, so the editor can show it", async () => {
		const r = await call("PUT", "/mine/notifications", { allOff: true });
		expect(r.body.rules).toEqual([{ inapp: false, push: false }]);
		expect((await configOf("mine")).notifications).toEqual({ rules: [{ inapp: false, push: false }] });
		for (const row of r.body.effective) {
			expect(row.push.allowed, `${row.type}/${row.severity}`).toBe(false);
			expect(row.inapp.allowed).toBe(false);
		}
		expect((await call("PUT", "/mine/notifications", { allOff: true, rules: [] })).status).toBe(400);
		expect((await call("PUT", "/mine/notifications", { allOff: "yes" })).status).toBe(400);
	});

	it("REFUSES a rule it cannot evaluate rather than dropping it", async () => {
		for (const bad of [
			{ rules: "off" },
			{ rules: [{ type: "aply", push: false }] },
			{ rules: [{ event: "approvals", push: false }] },
			{ rules: [{ type: "apply" }] },
			{ rules: [{ type: "apply", severity: "urgent", push: false }] },
			{ rules: [{ type: "apply", push: "no" }] },
			{ rules: [{ type: "apply", push: false, when: "later" }] },
			{ rules: [null] },
		]) {
			const r = await call("PUT", "/mine/notifications", bad);
			expect(r.status, JSON.stringify(bad)).toBe(400);
		}
		// Nothing was written on the way to any of those 400s.
		expect((await configOf("mine")).notifications).toBeUndefined();
	});

	it("restores inherited by removing the override, not by writing an empty one", async () => {
		await call("PUT", "/mine/notifications", { rules: [{ push: false }] });
		const r = await call("DELETE", "/mine/notifications");
		expect(r.status).toBe(200);
		expect(r.body.restored).toBe(true);
		expect(r.body.rules).toEqual([]);
		const cfg = await configOf("mine");
		expect(cfg.notifications, "absent, which is the state that means `inherit`").toBeUndefined();
		expect(cfg.voice).toEqual({ speed: 130 });
		for (const row of r.body.effective) expect(row.push.source).toBe("baseline");
	});

	it("an empty list is the same as inheriting, and stores nothing", async () => {
		await call("PUT", "/mine/notifications", { rules: [{ push: false }] });
		const r = await call("PUT", "/mine/notifications", { rules: [] });
		expect(r.body.rules).toEqual([]);
		expect((await configOf("mine")).notifications).toBeNull();
	});
});

describe("tenant isolation", () => {
	it("cannot read or write another owner's instance", async () => {
		expect((await call("GET", "/theirs/notifications")).status).toBe(404);
		expect((await call("PUT", "/theirs/notifications", { rules: [{ push: false }] })).status).toBe(404);
		expect((await call("DELETE", "/theirs/notifications")).status).toBe(404);
		expect((await configOf("theirs")).notifications).toBeUndefined();
	});

	it("one instance's policy does not touch another of the same owner's", async () => {
		d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('other', 'a1', 'u1', 'active', '{}')`);
		await call("PUT", "/mine/notifications", { allOff: true });
		const other = await call("GET", "/other/notifications");
		expect(other.body.rules).toEqual([]);
		for (const row of other.body.effective) expect(row.push.allowed).toBe(true);
	});
});
