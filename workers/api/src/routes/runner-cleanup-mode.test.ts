/**
 * #1265 — the per-machine cleanup mode on the platform side, end to end over the real schema.
 *
 * The owner sets a mode (and per-behaviour switches) on a MACHINE; the heartbeat answer carries the resolved
 * policy to the runner; the runner's own report comes back, is sanitized, and shows in the node list. The
 * report is telemetry — it must never change the mode. And "clean now" is asked until the machine says done.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { type RealSchemaD1, realSchemaD1 } from "../lib/d1-sqlite.js";
import { behaviourDefaults, applyChange, parseCleanupChange, resolveBehaviours, sanitizeReport } from "../lib/runner-cleanup-policy.js";
import type { Env } from "../types.js";

let uid = "u1";
vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid, roles: [] }) };
});

const { instanceRoutes } = await import("./instances.js");
const { terminalRoutes } = await import("./terminals.js");

const MINI = "mini-0000-machine-id";
const PINK = "pink-0000-machine-id";
let d1: RealSchemaD1;

beforeEach(() => {
	uid = "u1";
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag', 'u1', 'cl-coder', 'Coder', '{"capabilities":{"surfaces":["coding"],"runtime":"coding"}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i-mini', 'ag', 'u1', 'active', '{}'), ('i-pink', 'ag', 'u1', 'active', '{}')`);
	for (const [inst, node, machine] of [["i-mini", "Sergeys-Mac-mini.local", MINI], ["i-pink", "pink-laptop", PINK]] as const) {
		d1.exec(`INSERT INTO instance_runtimes (instance_id, user_id, endpoint_url, runner_node, status) VALUES ('${inst}', 'u1', 'relay://', '${node}', 'online')`);
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, status, last_seen_at) VALUES ('${inst}', 'u1', '${node}', 'relay://', '0.4.80', '${machine}', 'online', '2026-10-21 06:00:00')`);
	}
});
afterEach(() => d1.close());

function app() {
	const a = new Hono<{ Bindings: Env }>();
	a.route("/v1/instances", instanceRoutes);
	a.route("/v1/terminals", terminalRoutes);
	a.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	return a;
}
const relay = { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response(JSON.stringify({ connected: false })) }) };
const env = () => ({ DB: d1.DB, RELAY: relay }) as unknown as Env;

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read field by field in assertions
type Beat = Record<string, any>;
async function heartbeat(instance: "i-mini" | "i-pink", body: Record<string, unknown> = {}): Promise<Beat> {
	const node = instance === "i-mini" ? "Sergeys-Mac-mini.local" : "pink-laptop";
	const machineId = instance === "i-mini" ? MINI : PINK;
	const res = await app().request(`/v1/instances/${instance}/runtime/heartbeat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runnerNode: node, machineId, ...body }) }, env());
	expect(res.status).toBe(200);
	return (await res.json()) as Beat;
}
async function setPolicy(machineId: string, body: Record<string, unknown>) {
	const res = await app().request(`/v1/terminals/machines/${machineId}/policy`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env());
	return { status: res.status, json: (await res.json()) as Beat };
}
async function nodes(): Promise<Beat[]> {
	return ((await (await app().request("/v1/terminals/nodes", {}, env())).json()) as { nodes: Beat[] }).nodes;
}
const nodeNamed = async (name: string) => (await nodes()).find((n) => n.node === name) as Beat;

describe("the default and the heartbeat answer", () => {
	it("a machine nobody configured is GENTLE, with cache pruning off, and the runner is told so", async () => {
		const beat = await heartbeat("i-mini");
		expect(beat.cleanupPolicy).toEqual({ mode: "gentle", behaviours: behaviourDefaults("gentle") });
		expect(beat.cleanupPolicy.behaviours.cachePruning).toBe(false);
		expect(beat.cleanupNow).toBeNull();
	});

	it("keeps cleanup OUT of the autoUpdatePolicy the update channel reads", async () => {
		const beat = await heartbeat("i-mini");
		expect(beat.autoUpdatePolicy).not.toHaveProperty("cleanup");
		expect(beat.autoUpdatePolicy).toMatchObject({ autoUpdate: false });
	});

	it("reports the active mode in the node list (list_runner_nodes) from the start", async () => {
		await heartbeat("i-mini");
		expect(await nodeNamed("Sergeys-Mac-mini.local")).toMatchObject({ cleanup_mode: "gentle", cleanup: { mode: "gentle", orphaned_processes: null, now_pending: false } });
	});
});

describe("setting the mode per machine", () => {
	it("harsh on one machine does not touch another — Mac mini gentle, pink-laptop harsh", async () => {
		expect((await setPolicy(PINK, { cleanup_mode: "harsh" })).status).toBe(200);
		expect((await heartbeat("i-pink")).cleanupPolicy).toEqual({ mode: "harsh", behaviours: behaviourDefaults("harsh") });
		expect((await heartbeat("i-pink")).cleanupPolicy.behaviours.cachePruning).toBe(true);
		expect((await heartbeat("i-mini")).cleanupPolicy.mode).toBe("gentle");
		expect((await nodeNamed("pink-laptop")).cleanup_mode).toBe("harsh");
		expect((await nodeNamed("Sergeys-Mac-mini.local")).cleanup_mode).toBe("gentle");
	});

	it("a machine can be set explicitly to gentle (the Mac mini)", async () => {
		const r = await setPolicy(MINI, { cleanup_mode: "gentle" });
		expect(r.json.machine.cleanup).toMatchObject({ mode: "gentle", overrides: {} });
	});

	it("each checkbox overrides the mode's default for that machine", async () => {
		await setPolicy(PINK, { cleanup_mode: "harsh", cleanup_overrides: { cachePruning: false, browserCleanup: false } });
		const policy = (await heartbeat("i-pink")).cleanupPolicy;
		expect(policy.mode).toBe("harsh");
		expect(policy.behaviours).toEqual({ ...behaviourDefaults("harsh"), cachePruning: false, browserCleanup: false });
		await setPolicy(MINI, { cleanup_overrides: { cachePruning: true } }); // gentle + the one extra
		expect((await heartbeat("i-mini")).cleanupPolicy.behaviours.cachePruning).toBe(true);
	});

	it("changing the MODE resets the checkboxes to its defaults (the master toggle), unless the same request sets some", async () => {
		await setPolicy(PINK, { cleanup_mode: "harsh", cleanup_overrides: { cachePruning: false } });
		const flipped = await setPolicy(PINK, { cleanup_mode: "gentle" });
		expect(flipped.json.machine.cleanup.overrides).toEqual({});
		const again = await setPolicy(PINK, { cleanup_mode: "harsh", cleanup_overrides: { tempCleanup: false } });
		expect(again.json.machine.cleanup.overrides).toEqual({ tempCleanup: false });
	});

	it("a null override returns one checkbox to the mode's default", async () => {
		await setPolicy(PINK, { cleanup_mode: "harsh", cleanup_overrides: { cachePruning: false, loadWarning: false } });
		const r = await setPolicy(PINK, { cleanup_overrides: { cachePruning: null } });
		expect(r.json.machine.cleanup.overrides).toEqual({ loadWarning: false });
		expect(r.json.machine.cleanup.behaviours.cachePruning).toBe(true);
	});

	it("leaves Auto-update exactly as it was", async () => {
		await setPolicy(PINK, { auto_update: true });
		const r = await setPolicy(PINK, { cleanup_mode: "harsh" });
		expect(r.json.machine.auto_update_policy).toBe(true);
		await setPolicy(MINI, { cleanup_mode: "harsh" }); // a machine that had no policy row at all
		expect((await setPolicy(MINI, { cleanup_mode: "gentle" })).json.machine.auto_update_policy).toBe(false);
	});

	it.each([
		[{ cleanup_mode: "nuclear" }, /gentle.*harsh/],
		[{ cleanup_mode: 5 }, /gentle.*harsh/],
		[{ cleanup_overrides: [] }, /object/],
		[{ cleanup_overrides: { rmRf: true } }, /Unknown cleanup behaviour/],
		[{ cleanup_overrides: { cachePruning: "yes" } }, /true, false or null/],
		[{ cleanup_now: false }, /cleanup_now must be true/],
	])("refuses a bad request %j without changing anything", async (body, message) => {
		await setPolicy(PINK, { cleanup_mode: "harsh" });
		const r = await setPolicy(PINK, body);
		expect(r.status).toBe(400);
		expect(JSON.stringify(r.json)).toMatch(message);
		expect((await heartbeat("i-pink")).cleanupPolicy.mode).toBe("harsh");
	});

	it("is owner-scoped: another account cannot set the mode on this machine", async () => {
		uid = "u2";
		expect((await setPolicy(PINK, { cleanup_mode: "harsh" })).status).toBe(404);
		uid = "u1";
		expect((await heartbeat("i-pink")).cleanupPolicy.mode).toBe("gentle");
	});
});

describe("the runner's report", () => {
	const status = (over: Record<string, unknown> = {}) => ({
		mode: "harsh",
		behaviours: {},
		orphanedProcesses: 3,
		orphans: [{ pid: 4242, reason: "workdir-orphan", command: "node /x/vite", sessionId: null }],
		loadMismatch: true,
		unexplainedLoad: 79.46,
		diskUsedPct: 95.4,
		warnings: ["disk is 95% full and cache pruning is off on this machine"],
		lastPass: { at: "2026-10-21T05:00:00.000Z", reason: "requested", killedProcesses: 2, orphansFound: 3, browsersReaped: 1, tempFoldersRemoved: 4, worktreesRemoved: 0, cachesPruned: 2, buildOutputsRemoved: 7, freedBytes: 3_500_000_000 },
		...over,
	});

	it("is stored and shown in the node list: leftovers found, warnings, the last pass and the bytes freed", async () => {
		await heartbeat("i-pink", { cleanup: status() });
		const n = await nodeNamed("pink-laptop");
		expect(n.cleanup).toMatchObject({ orphaned_processes: 3, warnings: ["disk is 95% full and cache pruning is off on this machine"], last_pass: { freedBytes: 3_500_000_000, buildOutputsRemoved: 7, killedProcesses: 2 } });
		expect(n.cleanup.reported_at).toBeTruthy();
	});

	it("is telemetry only: a runner claiming to be harsh does not make its machine harsh", async () => {
		await heartbeat("i-mini", { cleanup: status({ mode: "harsh" }) });
		expect((await heartbeat("i-mini")).cleanupPolicy.mode).toBe("gentle");
		expect((await nodeNamed("Sergeys-Mac-mini.local")).cleanup_mode).toBe("gentle");
	});

	it("is bounded and typed: oversized and malformed fields are clipped or dropped", () => {
		const view = sanitizeReport(status({ orphans: Array.from({ length: 50 }, (_, i) => ({ pid: i + 2, reason: "x".repeat(500), command: "c".repeat(5000), sessionId: "s".repeat(500) })), warnings: Array.from({ length: 50 }, () => "w".repeat(1000)), orphanedProcesses: "lots", diskUsedPct: 400, unexplainedLoad: -5 }));
		expect(view?.orphans).toHaveLength(10);
		expect(view?.orphans[0].command.length).toBeLessThanOrEqual(180);
		expect(view?.orphans[0].reason.length).toBeLessThanOrEqual(30);
		expect(view?.warnings).toHaveLength(5);
		expect(view?.orphanedProcesses).toBe(0);
		expect(view?.diskUsedPct).toBe(100);
		expect(view?.unexplainedLoad).toBe(0);
		expect(sanitizeReport("junk")).toBeNull();
		expect(sanitizeReport(null)).toBeNull();
	});

	it("an unchanged report is not rewritten on every beat", async () => {
		await heartbeat("i-pink", { cleanup: status() });
		const before = d1.issued.filter((s) => /INSERT INTO machine_policies/.test(s.sql) && /cleanup_report/.test(s.sql)).length;
		await heartbeat("i-pink", { cleanup: status() });
		await heartbeat("i-pink", { cleanup: status() });
		expect(d1.issued.filter((s) => /INSERT INTO machine_policies/.test(s.sql) && /cleanup_report/.test(s.sql)).length).toBe(before);
		await heartbeat("i-pink", { cleanup: status({ orphanedProcesses: 0 }) }); // a changed one is
		expect(d1.issued.filter((s) => /INSERT INTO machine_policies/.test(s.sql) && /cleanup_report/.test(s.sql)).length).toBe(before + 1);
	});

	it("an older runner that sends no cleanup block changes nothing", async () => {
		await setPolicy(PINK, { cleanup_mode: "harsh" });
		await heartbeat("i-pink");
		expect((await nodeNamed("pink-laptop")).cleanup).toMatchObject({ mode: "harsh", orphaned_processes: null });
	});
});

describe("'clean now'", () => {
	it("is asked on every heartbeat until the machine reports that it finished THAT request", async () => {
		await setPolicy(PINK, { cleanup_mode: "harsh", cleanup_now: true });
		const first = await heartbeat("i-pink");
		const requestedAt = first.cleanupNow.requestedAt as number;
		expect(requestedAt).toBeGreaterThan(0);
		expect((await heartbeat("i-pink")).cleanupNow).toEqual({ requestedAt });
		expect((await nodeNamed("pink-laptop")).cleanup.now_pending).toBe(true);
		// A report of finishing an OLDER request does not satisfy it…
		expect((await heartbeat("i-pink", { cleanupNowDoneAt: requestedAt - 1000 })).cleanupNow).toEqual({ requestedAt });
		// …the one that matches does.
		expect((await heartbeat("i-pink", { cleanupNowDoneAt: requestedAt })).cleanupNow).toBeNull();
		expect((await heartbeat("i-pink")).cleanupNow).toBeNull();
		expect((await nodeNamed("pink-laptop")).cleanup.now_pending).toBe(false);
	});

	it("a runner cannot claim to have finished a request in the future", async () => {
		await setPolicy(PINK, { cleanup_now: true });
		const { cleanupNow } = await heartbeat("i-pink");
		await heartbeat("i-pink", { cleanupNowDoneAt: Date.now() + 10 * 3600_000 });
		expect((await heartbeat("i-pink")).cleanupNow).toEqual(cleanupNow);
	});

	it("only the machine that was asked is asked", async () => {
		await setPolicy(PINK, { cleanup_now: true });
		expect((await heartbeat("i-mini")).cleanupNow).toBeNull();
		expect((await heartbeat("i-pink")).cleanupNow).not.toBeNull();
	});

	it("a second request after the first finished asks again", async () => {
		await setPolicy(PINK, { cleanup_now: true });
		const a = (await heartbeat("i-pink")).cleanupNow.requestedAt as number;
		await heartbeat("i-pink", { cleanupNowDoneAt: a });
		await new Promise((r) => setTimeout(r, 5));
		await setPolicy(PINK, { cleanup_now: true });
		const b = (await heartbeat("i-pink")).cleanupNow.requestedAt as number;
		expect(b).toBeGreaterThan(a);
	});
});

describe("the pure resolver", () => {
	it("gentle defaults: everything on except cache pruning; harsh: everything on", () => {
		expect(behaviourDefaults("gentle")).toEqual({ processGroupKill: true, leftoverSweep: true, browserCleanup: true, tempCleanup: true, loadWarning: true, cachePruning: false });
		expect(Object.values(behaviourDefaults("harsh")).every(Boolean)).toBe(true);
	});
	it("parses nothing as no change, and the nested form", () => {
		expect(parseCleanupChange({ auto_update: true })).toBeNull();
		expect(parseCleanupChange({ cleanup: { mode: "harsh", overrides: { cachePruning: false } } })).toEqual({ mode: "harsh", overrides: { cachePruning: false } });
	});
	it("applyChange keeps overrides when the mode is unchanged and clears them when it changes", () => {
		const cur = { mode: "harsh" as const, overrides: { cachePruning: false } };
		expect(applyChange(cur, { mode: "harsh" }).overrides).toEqual({ cachePruning: false });
		expect(applyChange(cur, { mode: "gentle" }).overrides).toEqual({});
		expect(resolveBehaviours(applyChange(cur, { overrides: { cachePruning: null } })).cachePruning).toBe(true);
	});
});
