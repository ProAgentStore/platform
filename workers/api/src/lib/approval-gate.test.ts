import { describe, expect, it, vi } from "vitest";

// Importing the assembled app (to walk its route table) pulls in the Durable Object classes; same stand-in as request-id-correlation.test.ts.
vi.mock("cloudflare:workers", () => {
	class DurableObject {}
	class WorkflowEntrypoint extends DurableObject {}
	return { DurableObject, WorkflowEntrypoint };
});

import { type RealSchemaD1, realSchemaD1, seedTenant } from "./d1-sqlite.js";
import { ACTION_IDS, DEFAULT_ACTIONS, GATED_ACTIONS, GATE_ACTION, GATE_CHANGE_ACTION, type GateSettings, actionById, buildDiffPreview, decide, loadGate, matchPattern, matchRoute, mayBeGated, parseGateUpdate, redactForPreview, saveGate, weakensGate } from "./approval-gate.js";
import type { Env } from "../types.js";

const on = (actions: string[], expirySeconds = 3600): GateSettings => ({ enabled: true, actions, expirySeconds });

describe("matchPattern", () => {
	it("captures named segments and demands the same depth", () => {
		expect(matchPattern("/v1/instances/:id/coding/repos", "/v1/instances/i%201/coding/repos")).toEqual({ id: "i 1" });
		expect(matchPattern("/v1/instances/:id/coding/repos", "/v1/instances/i1/coding/repos/x")).toBeNull();
		expect(matchPattern("/v1/instances/:id/coding/repos", "/v1/instances//coding/repos")).toBeNull();
		expect(matchPattern("/v1/agents", "/v1/agents/")).toEqual({});
	});
});

describe("the registry", () => {
	const each = GATED_ACTIONS.flatMap((a) => a.routes.map((r) => ({ a, r })));

	it("gives every action a unique id, a label and a description", () => {
		expect(new Set(ACTION_IDS).size).toBe(ACTION_IDS.length);
		for (const a of GATED_ACTIONS) expect(a.label.length > 3 && a.description.length > 3, a.id).toBe(true);
	});

	it("the three minimum actions are on by default and the rest are opt-in (#1268)", () => {
		expect([...DEFAULT_ACTIONS].sort()).toEqual(["coder_create", "instance_create", "repo_add"]);
	});

	it.each(each.map(({ a, r }) => [`${a.id}: ${r.method} ${r.pattern}`, a, r] as const))("%s resolves to its own action", (_n, a, r) => {
		const path = r.pattern.replace(/:[a-zA-Z]+/g, "x1");
		const body = r.when ? { model: "m", engines: [] } : {};
		expect(matchRoute(r.method, path, body)?.action.id).toBe(a.id);
		expect(mayBeGated(r.method, path)).toBe(true);
	});

	it("does not match a read, or a route nobody registered", () => {
		expect(matchRoute("GET", "/v1/instances/i1/coding/repos")).toBeNull();
		expect(matchRoute("POST", "/v1/instances/i1/chat")).toBeNull();
	});

	it("a body-conditional route is gated only for the gated change", () => {
		expect(matchRoute("PUT", "/v1/instances/i1/state", { model: "gpt" })?.action.id).toBe("engine_model");
		expect(matchRoute("PUT", "/v1/instances/i1/state", { permissions: {} })).toBeNull();
	});

	it("describes a target and a diff without leaking secrets", () => {
		const action = actionById("repo_add")!;
		const preview = buildDiffPreview(action, { method: "post", path: "/v1/instances/i1/coding/repos", params: { id: "i1" }, body: { repo: "a/b", password: "hunter2", nested: { apiKey: "k" } }, before: { token: "t" } });
		expect(preview.target).toContain("a/b");
		expect(JSON.stringify(preview)).not.toMatch(/hunter2|"k"|"t"/);
		expect(preview.summary).toContain("repo: a/b");
		expect(redactForPreview({ list: Array.from({ length: 30 }, (_, i) => i) })).toEqual({ list: Array.from({ length: 20 }, (_, i) => i) });
	});
});

describe("settings", () => {
	it("an update keeps what it does not name, and defaults the checklist when turned on empty", () => {
		const r = parseGateUpdate({ enabled: true }, { enabled: false, actions: [], expirySeconds: 600 });
		expect(r).toEqual({ ok: true, next: { enabled: true, actions: [...DEFAULT_ACTIONS], expirySeconds: 600 } });
		expect(parseGateUpdate({ expirySeconds: 30 }, on(["repo_add"])).ok).toBe(false);
		expect(parseGateUpdate({ extra: 1 }, on(["repo_add"])).ok).toBe(false);
		expect(parseGateUpdate({ enabled: "yes" }, on(["repo_add"])).ok).toBe(false);
	});

	it("weakens = off, or fewer actions — never when it was already off or only grows", () => {
		const cur = on(["repo_add", "runner_repin"]);
		expect(weakensGate(cur, { ...cur, enabled: false })).toBe(true);
		expect(weakensGate(cur, { ...cur, actions: ["repo_add"] })).toBe(true);
		expect(weakensGate(cur, { ...cur, actions: ["repo_add", "runner_repin", "coder_create"] })).toBe(false);
		expect(weakensGate(cur, { ...cur, expirySeconds: 99999 })).toBe(false);
		expect(weakensGate({ ...cur, enabled: false }, cur)).toBe(false);
	});
});

describe("decide", () => {
	let d1: RealSchemaD1;
	const setup = async (s?: GateSettings) => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
		const env = { DB: d1.DB } as unknown as Env;
		if (s) await saveGate(env, "u1", s);
		return env;
	};
	const ask = (env: Env, method: string, path: string, body: Record<string, unknown> = {}) => decide(env, { method, path, body, userId: "u1" });

	it("with no row, or the gate off, nothing is gated — for any action", async () => {
		const env = await setup();
		for (const a of GATED_ACTIONS) for (const r of a.routes) expect((await ask(env, r.method, r.pattern.replace(/:[a-zA-Z]+/g, "x"), { model: "m" })).gated, a.id).toBe(false);
		await saveGate(env, "u1", { enabled: false, actions: [...ACTION_IDS], expirySeconds: 60 });
		expect((await ask(env, "POST", "/v1/agents")).gated).toBe(false);
		d1.close();
	});

	it("gates exactly the ticked actions", async () => {
		const env = await setup(on(["coder_create", "tool_allowlist"]));
		expect((await ask(env, "POST", "/v1/agents")).gated).toBe(true);
		expect((await ask(env, "PUT", "/v1/agents/a1/capabilities")).gated).toBe(true);
		expect((await ask(env, "POST", "/v1/instances/a1/subscribe")).gated).toBe(false);
		const held = await ask(env, "POST", "/v1/agents/a1/clone");
		expect(held.gated && held.action.id).toBe("coder_create");
		d1.close();
	});

	it("holds the gate's own change only when it weakens it, and whatever the checklist says", async () => {
		const env = await setup(on(["repo_add"]));
		const weaken = await ask(env, "PUT", "/v1/approval-gate", { enabled: false });
		expect(weaken.gated && weaken.action.id).toBe(GATE_CHANGE_ACTION);
		expect((await ask(env, "PUT", "/v1/approval-gate", { actions: ["repo_add", "coder_create"] })).gated).toBe(false);
		expect((await ask(env, "PUT", "/v1/approval-gate", { enabled: "bad" })).gated).toBe(false);
		expect(GATE_ACTION.defaultOn).toBe(true);
		d1.close();
	});

	it("round-trips settings and ignores unknown stored action ids", async () => {
		const env = await setup(on(["repo_add"], 120));
		d1.exec(`UPDATE account_approval_gate SET actions = '["repo_add","ghost",7]'`);
		expect(await loadGate(env, "u1")).toEqual({ enabled: true, actions: ["repo_add"], expirySeconds: 120 });
		d1.close();
	});
});

describe("every registered route is a real route (#1268: no silent miss)", () => {
	it("each gated pattern matches a handler mounted on the assembled app", async () => {
		const { apiApp } = await import("../index.js");
		const mounted = apiApp.routes.map((r) => ({ method: r.method.toUpperCase(), path: r.path }));
		const matches = (method: string, pattern: string) =>
			mounted.some((m) => (m.method === method || m.method === "ALL") && matchPattern(m.path.replace(/:[a-zA-Z]+(\{[^}]*\})?/g, ":p"), pattern.replace(/:[a-zA-Z]+/g, ":p")) !== null);
		const missing = [...GATED_ACTIONS, GATE_ACTION].flatMap((a) => a.routes.filter((r) => !matches(r.method, r.pattern)).map((r) => `${a.id}: ${r.method} ${r.pattern}`));
		expect(missing).toEqual([]);
	}, 30_000); // Importing the assembled API can exceed Vitest's 5s default under load.
});
