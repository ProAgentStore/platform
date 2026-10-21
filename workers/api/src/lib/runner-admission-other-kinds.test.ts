/**
 * #1175 — the admission gate (#1264) applies to browser, application-tailor and application-runner starts, not only to coding
 * sessions: an overloaded machine refuses them with the same reason before any run row or application move exists, and
 * a machine that is accepting (or whose state is unknown) refuses nothing. Real migrated schema; the browser start runs the real
 * store with the runtime and capability stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types.js";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import { parseLocalBrowserCapability } from "./local-browser/policy.js";
import { activeWorkOn } from "./runner-resources.js";
import { describeRejection, overloadRefusal } from "./runner-admission-gate.js";

const calls: string[] = [];
let runtimeNode = "mac-mini";
vi.mock("../routes/instances-runtime.js", async () => {
	const actual = await vi.importActual<typeof import("../routes/instances-runtime.js")>("../routes/instances-runtime.js");
	return {
		...actual,
		getLiveRuntime: async () => ({ runner_node: runtimeNode, runner_version: "0.4.173", endpoint_url: "relay://", token_plaintext: "t" }),
		callRuntime: async (_env: unknown, _rt: unknown, path: string) => {
			calls.push(path);
			return new Response(JSON.stringify({ taskId: "task-1" }), { status: 200 });
		},
		runtimeJson: async (res: Response) => res.json(),
	};
});
vi.mock("./agent-capabilities.js", () => ({
	capabilitiesForInstance: async () => {
		const c = parseLocalBrowserCapability({});
		if ("error" in c) throw new Error(c.error);
		return { runtime: "local_browser", localBrowser: c };
	},
}));
const { startLocalBrowserRun } = await import("./local-browser/start.js");

let d1: RealSchemaD1;
let env: Env;
const REJECTING = JSON.stringify({ state: "rejecting", metric: "memory", value: 99.6, threshold: 92, streak: 0, since: 1 });

beforeEach(() => {
	calls.length = 0;
	runtimeNode = "mac-mini";
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'u1')");
	d1.exec("INSERT INTO agents (id, owner_id, slug, name) VALUES ('ag', 'u1', 't1175', 'Scout')");
	d1.exec("INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('inst-1', 'ag', 'u1', 'active', '{}')");
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

function node(name: string, gate: string | null) {
	d1.sqlite.prepare("INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, status, gate_state, last_seen_at) VALUES ('inst-1', 'u1', ?, 'relay://', 'registered', ?, datetime('now'))").run(name, gate);
}

describe("overloadRefusal (#1175)", () => {
	it("refuses on a rejecting machine with the gate's reason, worded for the kind of work", async () => {
		node("mac-mini", REJECTING);
		const msg = await overloadRefusal(env, "inst-1", "u1", "mac-mini", "browser runs", false);
		expect(msg).toMatch(/mac-mini is overloaded \(memory: 99\.6% used \(threshold 92%\)\)/);
		expect(msg).toMatch(/New browser runs are refused/);
		expect(msg).toMatch(/start it again once it has/);
		expect(await overloadRefusal(env, "inst-1", "u1", "mac-mini", "application runs", true)).toMatch(/will retry automatically/);
	});

	it("refuses nothing on an accepting machine, with no node, or when the state cannot be read", async () => {
		node("mac-mini", JSON.stringify({ state: "accepting", streak: 0 }));
		expect(await overloadRefusal(env, "inst-1", "u1", "mac-mini", "browser runs", false)).toBeNull();
		expect(await overloadRefusal(env, "inst-1", "u1", "never-registered", "browser runs", false)).toBeNull();
		expect(await overloadRefusal(env, "inst-1", "u1", "", "browser runs", false)).toBeNull();
		expect(await overloadRefusal(env, "inst-1", "u1", null, "browser runs", false)).toBeNull();
		expect(await overloadRefusal({ DB: { prepare: () => { throw new Error("D1 down"); } } } as unknown as Env, "inst-1", "u1", "mac-mini", "browser runs", false)).toBeNull();
	});

	it("keeps the original coding wording when no kind is given", () => {
		expect(describeRejection({ code: "runner_overloaded", metric: "sessions", value: 3, threshold: 2, node: "m" })).toMatch(/New coding sessions are refused until it recovers; this run is deferred and will retry automatically/);
	});
});

describe("a browser run on an overloaded machine (#1175)", () => {
	it("is refused before it reaches the runner: failed as runner_overloaded with the reason, nothing dispatched", async () => {
		node("mac-mini", REJECTING);
		const out = await startLocalBrowserRun(env, "inst-1", "u1", { objective: "find roles", requestId: "req-1", source: "owner" });
		expect(out.kind).toBe("started");
		if (out.kind !== "started") return;
		expect(out.run).toMatchObject({ status: "failed", errorCode: "runner_overloaded" });
		expect(out.run.error).toMatch(/mac-mini is overloaded/);
		expect(calls).toEqual([]);
	});

	it("goes through on an accepting machine, and the same call after the machine recovers", async () => {
		node("mac-mini", REJECTING);
		await startLocalBrowserRun(env, "inst-1", "u1", { objective: "find roles", requestId: "req-1", source: "owner" });
		d1.sqlite.prepare("UPDATE instance_runtime_nodes SET gate_state = ? WHERE runner_node = 'mac-mini'").run(JSON.stringify({ state: "accepting", streak: 2 }));
		const out = await startLocalBrowserRun(env, "inst-1", "u1", { objective: "find roles again", requestId: "req-2", source: "owner" });
		expect(out.kind === "started" && out.run.status).toBe("running");
		expect(calls).toHaveLength(1);
	});

	it("is judged on the machine that would take it: another machine's overload does not matter", async () => {
		node("dell", REJECTING);
		node("mac-mini", JSON.stringify({ state: "accepting", streak: 0 }));
		const out = await startLocalBrowserRun(env, "inst-1", "u1", { objective: "x", requestId: "req-3", source: "owner" });
		expect(out.kind === "started" && out.run.status).toBe("running");
	});
});

describe("every runtime kind counts toward the session limit (#1175)", () => {
	it("coding sessions, browser, tailor and apply runs on a machine are summed — and other machines' are not", async () => {
		d1.exec("INSERT INTO users (id, github_login) VALUES ('u2', 'u2')");
		const n = async () => activeWorkOn(env, "u1", ["mac-mini"]);
		expect(await n()).toBe(0);
		d1.sqlite.prepare("INSERT INTO local_browser_runs (id, instance_id, user_id, request_id, objective, status, policy, created_at, updated_at, runner_node) VALUES ('b1','inst-1','u1','r1','o','running','{}',1,1,'mac-mini')").run();
		d1.sqlite.prepare("INSERT INTO local_browser_runs (id, instance_id, user_id, request_id, objective, status, policy, created_at, updated_at, runner_node) VALUES ('b2','inst-1','u1','r2','o','running','{}',1,1,'dell')").run();
		expect(await n()).toBe(1);
	});
});
