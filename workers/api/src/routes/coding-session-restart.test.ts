/**
 * #1262 — `POST …/coding/sessions/:id/restart` fails accurately. With no runner connected nothing was restarted, so it is a 409
 * naming why and what to do (not a 200 with `ok:false` and no `error`, which the MCP tool read as "restarted"); a relaunch that
 * did not happen is non-2xx; only a real relaunch is 200 `ok:true`. Real route, real migrated schema; the runner (kill and
 * relaunch) is the only thing stubbed, and the relay's liveness is set per test.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { type RealSchemaD1, realSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const killed: string[] = [];
let stopError: string | null = null;
vi.mock("../lib/runner-client.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/runner-client.js")>("../lib/runner-client.js");
	return {
		...actual,
		callRunner: async (_conn: unknown, path: string, body: { sessionId?: string }) => {
			if (path === "/coding/end") {
				if (stopError) throw new Error(stopError);
				killed.push(body.sessionId ?? "");
			}
			return {};
		},
	};
});
let relaunch: { conn: unknown; resumed?: boolean; seeded?: boolean };
const relaunched: string[] = [];
vi.mock("../lib/coding-session-open.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/coding-session-open.js")>("../lib/coding-session-open.js");
	return {
		...actual,
		startSessionOnRunner: async (_env: unknown, _i: string, _u: string, session: { id: string }) => {
			relaunched.push(session.id);
			return relaunch;
		},
	};
});
const { codingRoutes } = await import("./coding.js");

let d1: RealSchemaD1;
let live: Set<string>;

beforeEach(() => {
	live = new Set();
	killed.length = 0;
	relaunched.length = 0;
	stopError = null;
	relaunch = { conn: { runnerNode: "laptop" }, resumed: false, seeded: true };
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'u1')");
	d1.exec("INSERT INTO agents (id, owner_id, slug, name) VALUES ('ag', 'u1', 't1262', 'Coder')");
	d1.exec("INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('inst-1', 'ag', 'u1', 'active', '{}')");
	d1.exec("INSERT INTO coding_repos (id, instance_id, user_id, name, clone_status) VALUES ('repo-1', 'inst-1', 'u1', 'platform', 'ready')");
	d1.exec("INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, runner_node) VALUES ('csess-1', 'inst-1', 'repo-1', 'u1', 'active', 'laptop')");
	d1.exec("INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, status, last_seen_at) VALUES ('inst-1', 'u1', 'laptop', 'relay://', 'registered', datetime('now'))");
});
afterEach(() => d1.close());

const relay = (liveNodes: () => Set<string>) => ({
	idFromName: (n: string) => n,
	get: (name: string) => ({ fetch: async () => new Response(JSON.stringify({ connected: liveNodes().has(name.split(":node:")[1] ?? "") })) }),
});

async function restart(sessionId = "csess-1") {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", codingRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: (e as Error).message }, 500)));
	const res = await app.request(`/v1/instances/inst-1/coding/sessions/${sessionId}/restart`, { method: "POST" }, { DB: d1.DB, RELAY: relay(() => live) } as unknown as Env);
	// biome-ignore lint/suspicious/noExplicitAny: loose response JSON
	return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe("restart with no runner connected (#1262)", () => {
	it("is a 409 with an error that says nothing was restarted, why, and what to do — and touches no engine", async () => {
		const r = await restart();
		expect(r.status).toBe(409);
		expect(r.json).toMatchObject({ ok: false, runnerConnected: false });
		expect(r.json.error).toMatch(/^Session not restarted: /);
		expect(r.json.error).toMatch(/pags up/);
		expect(r.json.error).toMatch(/Nothing was stopped or relaunched/);
		expect(killed).toEqual([]);
		expect(relaunched).toEqual([]);
	});

	it("carries the diagnosis, so a session whose machine is off while ANOTHER runs is not told to 'run pags up' blindly", async () => {
		d1.exec("INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, status, last_seen_at) VALUES ('inst-1', 'u1', 'desktop', 'relay://', 'registered', datetime('now'))");
		live.add("desktop"); // another machine is up; the session's own ('laptop') is not
		const r = await restart();
		expect(r.status).toBe(409);
		expect(r.json.attachment).toBeTruthy();
		expect(r.json.error).toContain(r.json.attachment.message);
	});

	it("still 404s an unknown session and 409s an ended one BEFORE it looks for a runner", async () => {
		expect((await restart("nope")).status).toBe(404);
		d1.exec("UPDATE coding_sessions SET status = 'ended'");
		const ended = await restart();
		expect(ended.status).toBe(409);
		expect(ended.json.error).toBe("session has ended");
	});
});

describe("restart with a runner connected", () => {
	beforeEach(() => live.add("laptop"));

	it("stops the engine, relaunches it, and answers 200 ok:true with what the new engine came up holding", async () => {
		const r = await restart();
		expect(r.status).toBe(200);
		expect(r.json).toEqual({ ok: true, runnerConnected: true, resumed: false, seeded: true });
		expect(killed).toEqual(["csess-1"]);
		expect(relaunched).toEqual(["csess-1"]);
	});

	it("a failed stop is a 409 and the engine is NOT relaunched (two engines on one tree)", async () => {
		stopError = "runner timeout";
		const r = await restart();
		expect(r.status).toBe(409);
		expect(r.json).toMatchObject({ ok: false, runnerConnected: true });
		expect(r.json.error).toMatch(/Could not stop the running engine/);
		expect(relaunched).toEqual([]);
	});

	it("a relaunch that did not happen is a 502 carrying the reason — never a 200 with ok:false", async () => {
		relaunch = { conn: null };
		d1.exec("UPDATE coding_repos SET clone_status = 'error', clone_error = 'git clone failed: repository not found'");
		const r = await restart();
		expect(r.status).toBe(502);
		expect(r.json).toMatchObject({ ok: false, runnerConnected: true, error: "git clone failed: repository not found" });
		expect(killed).toEqual(["csess-1"]); // the old engine WAS stopped: this is a failure, not a no-op
	});

	it("a relaunch failure with no recorded reason still says so", async () => {
		relaunch = { conn: null };
		const r = await restart();
		expect(r.status).toBe(502);
		expect(r.json.error).toBe("Failed to start session on runner");
	});
});
