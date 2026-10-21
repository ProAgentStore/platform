/**
 * #1259 — `GET /v1/terminals/resources`: the whole fleet's resource history in one call.
 * Real route, real migrated schema, samples written through the real heartbeat path (`saveResourceSample`).
 * Covers: every owned machine in one response keyed by machine id with its display name; the caller's machines only; nothing secret;
 * the `since` cursor (live append); stale machines flagged, not zeroed; Windows load null (#1258); tiers; bad input; the 24h summary.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { type RealSchemaD1, realSchemaD1 } from "../lib/d1-sqlite.js";
import { summarize24h } from "../lib/fleet-resources.js";
import { saveResourceSample } from "../lib/runner-resources.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async (c: { req: { header: (n: string) => string | undefined } }) => ({ uid: c.req.header("x-test-uid") ?? "u1", roles: [] }) };
});
const { terminalRoutes } = await import("./terminals.js");

const GiB = 1024 ** 3;
const NOW = Date.parse("2026-10-22T10:00:00Z");
const SECRET_ENDPOINT = "https://relay.secret-host.example/connect/TOPSECRETTOKEN";
const SECRET_TOKEN = "tok_PLAINTEXT_DO_NOT_LEAK";
let d1: RealSchemaD1;
let env: Env;

const raw = (over: Record<string, unknown> = {}) => ({
	loadAvg: [1, 1, 1], cpus: 8, memTotalBytes: 16 * GiB, memFreeBytes: 8 * GiB, platform: "linux", sampledAt: NOW - 5_000,
	disk: { path: "/Users/someone/.config/proagentstore/repos", totalBytes: 500 * GiB, freeBytes: 250 * GiB, inodesTotal: 1000, inodesFree: 900 },
	relayRttMs: 120, runner: { startedAt: NOW - 3_600_000, uptimeSec: 3600, starts24h: 1, relayReconnects: 0, supervisor: "service", pid: 4242, rsid: "rs-secret", launch: "/usr/local/bin/pags up" },
	sessions: [{ sessionId: "SESSION-ID-LEAK", engineLabel: "Claude Code", pid: 7, processes: 2, rssBytes: GiB, cpuPct: 30 }],
	...over,
});

function node(user: string, instance: string, name: string, machineId: string | null) {
	d1.sqlite
		.prepare("INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, token_plaintext, machine_id, status, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, 'registered', ?)")
		.run(instance, user, name, SECRET_ENDPOINT, SECRET_TOKEN, machineId, new Date(NOW - 5_000).toISOString().replace("T", " ").substring(0, 19));
}
async function beat(user: string, instance: string, name: string, r: Record<string, unknown>) {
	await saveResourceSample(env, instance, user, name, r);
}

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')");
	d1.exec("INSERT INTO agents (id, owner_id, slug, name) VALUES ('ag', 'u1', 't1259', 'A'), ('ag2', 'u2', 't1259b', 'B')");
	d1.exec("INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'ag', 'u1', 'active', '{}'), ('i2', 'ag', 'u1', 'active', '{}'), ('i9', 'ag2', 'u2', 'active', '{}')");
	env = { DB: d1.DB } as unknown as Env;
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});
afterEach(() => {
	vi.useRealTimers();
	d1.close();
});

async function get(path: string, uid = "u1") {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/terminals", terminalRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(`/v1/terminals${path}`, { headers: { "x-test-uid": uid } }, env);
	const text = await res.text();
	// biome-ignore lint/suspicious/noExplicitAny: loose response JSON
	return { status: res.status, text, json: JSON.parse(text) as Record<string, any> };
}

describe("every owned machine in one call", () => {
	beforeEach(async () => {
		node("u1", "i1", "pink-laptop", "machine-pink-00000001");
		node("u1", "i2", "dell-laptop", "machine-dell-00000002");
		node("u2", "i9", "someone-elses", "machine-other-0000003");
		d1.sqlite.prepare("INSERT INTO machine_policies (user_id, machine_id, display_name) VALUES ('u1', 'machine-pink-00000001', 'Pink')").run();
		for (let i = 3; i >= 0; i--) {
			await beat("u1", "i1", "pink-laptop", raw({ sampledAt: NOW - i * 30_000 - 5_000, loadAvg: [i + 1, 1, 1] }));
			await beat("u1", "i2", "dell-laptop", raw({ sampledAt: NOW - i * 30_000 - 5_000, platform: "win32", loadAvg: [0, 0, 0] }));
		}
		await beat("u2", "i9", "someone-elses", raw({ sampledAt: NOW - 5_000 }));
	});

	it("returns both machines keyed by machine id, with the owner's display name, and not another account's", async () => {
		const r = await get("/resources");
		expect(r.status).toBe(200);
		expect(r.json.machines.map((m: { key: string }) => m.key).sort()).toEqual(["machine-dell-00000002", "machine-pink-00000001"]);
		const pink = r.json.machines.find((m: { machineId: string }) => m.machineId === "machine-pink-00000001");
		expect(pink).toMatchObject({ name: "Pink", node: "pink-laptop", stale: false, latest: { cpus: 8, supervisor: "service", platform: "linux" } });
		expect(pink.points).toHaveLength(4);
		expect(r.text).not.toContain("someone-elses");
		expect(r.json.tier).toBe("dense");
		expect(r.json.truncated).toBe(false);
	});

	it("nothing secret reaches the page: no endpoint, token, checkout path, session id, process id or launch command", async () => {
		const r = await get("/resources");
		for (const leak of [SECRET_ENDPOINT, "secret-host", "TOPSECRETTOKEN", SECRET_TOKEN, "/Users/someone", "SESSION-ID-LEAK", "rs-secret", "4242", "/usr/local/bin/pags", "endpoint", "token"]) expect(r.text, leak).not.toContain(leak);
	});

	it("a Windows machine's load is null all the way through (#1258): latest and every point", async () => {
		const dell = (await get("/resources")).json.machines.find((m: { machineId: string }) => m.machineId === "machine-dell-00000002");
		expect(dell.latest.loadPerCpu).toBeNull();
		for (const p of dell.points) expect(p.loadPerCpu).toBeNull();
	});

	it("points are oldest first, carry numbers only, and the cursor is the newest point", async () => {
		const r = await get("/resources");
		const pink = r.json.machines.find((m: { name: string }) => m.name === "Pink");
		const times = pink.points.map((p: { at: string }) => Date.parse(p.at));
		expect([...times].sort((a, b) => a - b)).toEqual(times);
		expect(Object.keys(pink.points[0]).sort()).toEqual(["at", "diskUsedPct", "loadPerCpu", "memUsedPct", "relayRttMs", "sessionCount", "starts24h"]);
		expect(pink.points[0]).toMatchObject({ diskUsedPct: 50, relayRttMs: 120, starts24h: 1, sessionCount: 1 });
		expect(r.json.cursor).toBe(new Date(NOW - 5_000).toISOString());
	});

	it("live append: `since` returns only newer points, and a new heartbeat appears on the next poll", async () => {
		const first = await get("/resources");
		const cursor = first.json.cursor as string;
		const quiet = await get(`/resources?since=${encodeURIComponent(cursor)}`);
		expect(quiet.json.machines.every((m: { points: unknown[] }) => m.points.length === 0)).toBe(true);
		expect(quiet.json.cursor).toBeNull();
		expect(quiet.json.machines.every((m: { summary24h?: unknown }) => m.summary24h === undefined)).toBe(true); // a poll is cheap: no summary
		vi.setSystemTime(NOW + 30_000);
		await beat("u1", "i1", "pink-laptop", raw({ sampledAt: NOW + 25_000, loadAvg: [9, 1, 1] }));
		const next = await get(`/resources?since=${Date.parse(cursor)}`);
		const pink = next.json.machines.find((m: { name: string }) => m.name === "Pink");
		expect(pink.points).toHaveLength(1);
		expect(pink.points[0]).toMatchObject({ at: new Date(NOW + 25_000).toISOString(), loadPerCpu: 1.13 });
		expect(next.json.cursor).toBe(new Date(NOW + 25_000).toISOString());
		expect(pink.stale).toBe(false);
	});

	it("a full load carries the 24h summary from the coarse tier; the coarse tier is selectable", async () => {
		const full = await get("/resources");
		const pink = full.json.machines.find((m: { name: string }) => m.name === "Pink");
		expect(pink.summary24h).toMatchObject({ buckets: 1, loadPeak: 0.5, restarts: 1 });
		const coarse = await get("/resources?tier=coarse");
		expect(coarse.json.tier).toBe("coarse");
		expect(coarse.json.machines.find((m: { name: string }) => m.name === "Pink").points.length).toBeGreaterThan(0);
	});
});

describe("stale and silent machines are marked, not zeroed", () => {
	it("a machine silent for over 3 minutes is stale with its age; one without any sample is stale with no latest", async () => {
		node("u1", "i1", "quiet-box", "machine-quiet-0000004");
		node("u1", "i2", "never-reported", "machine-never-0000005");
		await beat("u1", "i1", "quiet-box", raw({ sampledAt: NOW - 20 * 60_000 }));
		const r = await get("/resources");
		const quiet = r.json.machines.find((m: { node: string }) => m.node === "quiet-box");
		expect(quiet).toMatchObject({ stale: true, sampleAgeSec: 1200 });
		expect(quiet.latest.loadPerCpu).toBe(0.13); // its last real reading, not a zero
		const never = r.json.machines.find((m: { node: string }) => m.node === "never-reported");
		expect(never).toMatchObject({ stale: true, latest: null, sampledAt: null, sampleAgeSec: null, points: [] });
	});
});

describe("renamed machines are one machine", () => {
	it("two hostnames with the same machine id fold into one series carrying both names", async () => {
		node("u1", "i1", "Macmini", "machine-mini-00000006");
		node("u1", "i2", "Mac-mini.local", "machine-mini-00000006");
		await beat("u1", "i1", "Macmini", raw({ sampledAt: NOW - 60_000 }));
		await beat("u1", "i2", "Mac-mini.local", raw({ sampledAt: NOW - 10_000 }));
		const r = await get("/resources");
		expect(r.json.machines).toHaveLength(1);
		expect(r.json.machines[0].aka.concat(r.json.machines[0].node).sort()).toEqual(["Mac-mini.local", "Macmini"]);
		expect(r.json.machines[0].points).toHaveLength(2);
	});
});

describe("input and scope", () => {
	it("an unreadable from/to/since is a 400, and a caller with no machines gets an empty fleet", async () => {
		for (const q of ["from=yesterday", "to=nope", "since=abc"]) expect((await get(`/resources?${q}`)).status, q).toBe(400);
		const empty = await get("/resources", "u2");
		expect(empty.status).toBe(200);
		expect(empty.json.machines).toEqual([]);
		expect(empty.json.cursor).toBeNull();
	});

	it("is not shadowed by the per-node routes: /resources is the fleet, /nodes/:node/resources is one machine", async () => {
		node("u1", "i1", "pink-laptop", "machine-pink-00000001");
		await beat("u1", "i1", "pink-laptop", raw());
		expect((await get("/resources")).json.machines).toHaveLength(1);
		expect((await get("/nodes/pink-laptop/resources")).json).toMatchObject({ node: "pink-laptop" });
	});
});

describe("summarize24h", () => {
	it("is the mean and peak of the buckets' load, the median relay time and the highest restart count", () => {
		expect(summarize24h([{ loadPerCpu: 1, relayRttMs: 100, starts24h: 0 }, { loadPerCpu: 3, relayRttMs: 300, starts24h: 2 }, { loadPerCpu: null, relayRttMs: null, starts24h: null }])).toEqual({ buckets: 3, loadAvg: 2, loadPeak: 3, relayP50Ms: 200, restarts: 2 });
	});
	it("is null for no data, and keeps a Windows machine's load null rather than 0", () => {
		expect(summarize24h([])).toBeNull();
		expect(summarize24h([{ loadPerCpu: null, relayRttMs: 50, starts24h: 1 }])).toEqual({ buckets: 1, loadAvg: null, loadPeak: null, relayP50Ms: 50, restarts: 1 });
	});
});
