/**
 * A machine's resource history in two tiers, and the rest of the machine on the heartbeat (#924).
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

const { instanceRoutes } = await import("./instances.js");
const { terminalRoutes } = await import("./terminals.js");

const GiB = 1024 ** 3;
const MINI = "mini-0000-machine-id";
let d1: RealSchemaD1;

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag', 'u1', 't924-coder', 'Coder', '{"capabilities":{"surfaces":["coding"],"runtime":"coding"}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i-a', 'ag', 'u1', 'active', '{}'), ('i-b', 'ag', 'u1', 'active', '{}')`);
	for (const [inst, node] of [["i-a", "Macmini"], ["i-b", "Sergeys-Mac-mini.local"]] as const) {
		d1.exec(`INSERT INTO instance_runtimes (instance_id, user_id, endpoint_url, runner_node, status) VALUES ('${inst}', 'u1', 'relay://', '${node}', 'online')`);
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, status, last_seen_at)
		         VALUES ('${inst}', 'u1', '${node}', 'relay://', '0.4.71', '${MINI}', 'online', '2026-10-05 06:00:00')`);
	}
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i-a', 'u1', 'platform')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, user_id, repo_id, runner_node, client_type, status) VALUES
	  ('s1', 'i-a', 'u1', 'r1', 'Macmini', 'claude', 'active'),
	  ('s2', 'i-a', 'u1', 'r1', 'Macmini', 'claude', 'ended')`);
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

async function heartbeat(instanceId: string, body: Record<string, unknown>) {
	const res = await app().request(`/v1/instances/${instanceId}/runtime/heartbeat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env());
	expect(res.status).toBe(200);
}
async function machine() {
	const res = await app().request("/v1/terminals/nodes", {}, env());
	expect(res.status).toBe(200);
	const { nodes } = (await res.json()) as { nodes: Array<{ node: string; aka: string[]; resources: Record<string, unknown> | null }> };
	expect(nodes).toHaveLength(1); // one machine under two names
	return nodes[0];
}
const sample = (load1: number, at: number) => ({ loadAvg: [load1, 2, 1], cpus: 8, memTotalBytes: 16 * GiB, memFreeBytes: 4 * GiB, platform: "darwin", sampledAt: at });


const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 7, 6, 0);
async function history(node: string, qs = "") {
	const res = await app().request(`/v1/terminals/nodes/${node}/resources${qs}`, {}, env());
	return { status: res.status, body: (await res.json()) as { count: number; names: string[]; samples: Array<Record<string, unknown>> } };
}
const rows = (tier: string) => (d1.sqlite.prepare(`SELECT at, sample FROM runner_resource_samples WHERE tier = ? ORDER BY at`).all(tier) as Array<{ at: number; sample: string }>);

describe("two-tier resource history (#924)", () => {
	it("records one dense row per sample, however many agents heartbeat it", async () => {
		await heartbeat("i-a", { runnerNode: "Macmini", resources: sample(2, T0) });
		await heartbeat("i-a", { runnerNode: "Macmini", resources: sample(2, T0) });
		expect(rows("dense")).toHaveLength(1);
		expect(rows("coarse")).toHaveLength(1);
	});

	it("keeps ~2h dense and folds each 5-minute bucket into its WORST readings", async () => {
		// Every 30s for 3 hours: the dense tier keeps the last 2h, the coarse tier one row per 5 minutes.
		for (let t = 0; t <= 180 * MIN; t += 30_000) {
			const spike = t === 179 * MIN ? 40 : 1;
			await heartbeat("i-a", { runnerNode: "Macmini", resources: { ...sample(spike, T0 + t), memFreeBytes: (t === 178 * MIN ? 1 : 4) * GiB } });
		}
		const dense = rows("dense");
		expect(dense[0].at).toBeGreaterThanOrEqual(T0 + 60 * MIN);
		expect(dense.at(-1)?.at).toBe(T0 + 180 * MIN);
		const coarse = rows("coarse");
		expect(coarse).toHaveLength(37);
		const last = JSON.parse(coarse.at(-2)?.sample ?? "{}") as { loadAvg: number[]; memFreeBytes: number; samples: number };
		expect(last.loadAvg[0]).toBe(40); // the spike survives the bucket
		expect(last.memFreeBytes).toBe(1 * GiB); // and so does the low-water memory
		expect(last.samples).toBe(10);
	});

	it("serves a window of the history across every name the machine has, oldest first", async () => {
		await heartbeat("i-a", { runnerNode: "Macmini", resources: sample(1, T0) });
		await heartbeat("i-b", { runnerNode: "Sergeys-Mac-mini.local", resources: sample(9, T0 + MIN) });
		await heartbeat("i-a", { runnerNode: "Macmini", resources: sample(3, T0 + 20 * MIN) });
		const all = await history("Macmini", `?from=${T0 - MIN}&to=${T0 + 30 * MIN}`);
		expect(all.status).toBe(200);
		expect(all.body.names.sort()).toEqual(["Macmini", "Sergeys-Mac-mini.local"]);
		expect(all.body.samples.map((p) => p.load1)).toEqual([1, 9, 3]);
		const before = await history("Sergeys-Mac-mini.local", `?from=${new Date(T0 - MIN).toISOString()}&to=${new Date(T0 + 5 * MIN).toISOString()}`);
		expect(before.body.samples.map((p) => p.load1)).toEqual([1, 9]);
		const coarse = await history("Macmini", `?tier=coarse&from=${T0 - MIN}&to=${T0 + 30 * MIN}`);
		expect(coarse.body.samples.map((p) => [p.load1, p.samples])).toEqual([[9, 2], [3, 1]]);
	});

	it("refuses an unknown machine and a malformed window", async () => {
		expect((await history("nope")).status).toBe(404);
		await heartbeat("i-a", { runnerNode: "Macmini", resources: sample(1, T0) });
		expect((await history("Macmini", "?from=yesterday")).status).toBe(400);
	});
});

describe("disk, runner process, relay round trip and sessions (#924)", () => {
	const detail = {
		disk: { path: "/r", totalBytes: 100 * GiB, freeBytes: 5 * GiB, inodesTotal: 1000, inodesFree: 50 },
		runner: { startedAt: T0 - 5 * MIN, uptimeSec: 300, starts24h: 4, relayReconnects: 2 },
		relayRttMs: 2100,
		sessions: [
			{ sessionId: "s-lite", engineLabel: "codex:x", pid: 2, processes: 1, rssBytes: 1e8, cpuPct: 3 },
			{ sessionId: "s-hog", engineLabel: "claude:y", pid: 1, processes: 9, rssBytes: 4e9, cpuPct: 350 },
		],
	};

	it("reports each part and warns on the ones past their high-water marks", async () => {
		await heartbeat("i-a", { runnerNode: "Macmini", resources: { ...sample(1, T0), ...detail } });
		const r = (await machine()).resources as Record<string, unknown> & { warnings: string[]; sessions: Array<{ sessionId: string }> };
		expect(r).toMatchObject({
			disk: { path: "/r", usedPct: 95, inodesUsedPct: 95 },
			runner: { uptimeSec: 300, starts24h: 4, relayReconnects: 2 },
			relayRttMs: 2100,
			recommendedMaxSessions: 4,
		});
		expect(r.sessions.map((s) => s.sessionId)).toEqual(["s-hog", "s-lite"]); // heaviest first
		const w = r.warnings.join("\n");
		expect(w).toMatch(/Disk nearly full: 95%/);
		expect(w).toMatch(/Inodes nearly exhausted: 95%/);
		expect(w).toMatch(/started 4 times on this machine in 24 hours/);
		expect(w).toMatch(/Relay round trip 2100 ms/);
	});

	it("drops a malformed part and keeps the rest — absent is never zero", async () => {
		await heartbeat("i-a", { runnerNode: "Macmini", resources: { ...sample(1, T0), disk: { totalBytes: 10, freeBytes: 20 }, relayRttMs: null } });
		const r = (await machine()).resources as Record<string, unknown>;
		expect(r).toMatchObject({ load1: 1, disk: null, relayRttMs: null, runner: null, sessions: null });
	});

	it("warns when more sessions run than the machine's suggested capacity", async () => {
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r2', 'i-a', 'u1', 'two'), ('r3', 'i-a', 'u1', 'three')`);
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, user_id, repo_id, runner_node, client_type, status) VALUES ('s3', 'i-a', 'u1', 'r2', 'Macmini', 'claude', 'active'), ('s4', 'i-a', 'u1', 'r3', 'Macmini', 'claude', 'active')`);
		await heartbeat("i-a", { runnerNode: "Macmini", resources: { ...sample(1, T0), cpus: 4, memTotalBytes: 8 * GiB } });
		const r = (await machine()).resources as { warnings: string[]; recommendedMaxSessions: number; activeSessions: number };
		expect(r.recommendedMaxSessions).toBe(2);
		expect(r.activeSessions).toBe(3);
		expect(r.warnings.join("\n")).toMatch(/3 coding sessions active against a suggested 2/);
	});
});
