/**
 * The wake path opens a session on the pinned machine under ANY name it is provably known by (#1102).
 *
 * The live state on 2026-10-15/16: the platform Coder (a185b1db) was pinned to `Macmini.modem`; the Mac
 * mini's runner held its socket as `Sergeys-Mac-mini.local` (same machine_id 8de74159…). Opening a session
 * — the wake MCP's coding_session_message makes when nothing is active — probed only the literal pin and
 * answered "Runner node is not connected: Macmini.modem", while list_runner_nodes, force_runner_attach and
 * instance_runner_node (resolvedNode "Sergeys-Mac-mini.local") all read it connected. Over the real schema;
 * only the relay is faked: which `<instance>:node:<name>` slots hold a socket, and what a command returns.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { codingRoutes } = await import("./coding.js");

const CODER = "a185b1db-c560-456d-9522-f7792bd95cca";
const MINI = "8de74159-5e07-4e44-8472-56cc7b728cef";
const PINK = "e4fdf96a-0ebc-4dd6-bbd1-1f3a4b69599e";
let d1: RealSchemaD1;
let live: Set<string>;
let commands: string[];
const relay = {
	idFromName: (n: string) => n,
	get: (name: string) => ({
		fetch: async (req: Request) => {
			if (req.url.endsWith("/status")) return Response.json({ connected: live.has(name) });
			if (!live.has(name)) return new Response("no socket", { status: 503 });
			commands.push(name);
			return Response.json({ ok: true });
		},
	}),
};

beforeEach(() => {
	d1 = realSchemaD1();
	live = new Set();
	commands = [];
	seedTenant(d1, { userId: "u1", instanceIds: [CODER] });
	d1.exec(`UPDATE agent_instances SET config = '{"runnerNode":"Macmini.modem"}' WHERE id = '${CODER}'`);
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r1', '${CODER}', 'u1', 'ProAgentStore/platform', '/w/platform', 'ready')`);
	const row = (node: string, machine: string, seen: string) =>
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, status, last_seen_at)
		         VALUES ('${CODER}', 'u1', '${node}', 'relay://', '0.4.134', '${machine}', 'online', '${seen}')`);
	row("Macmini.modem", MINI, "2026-10-15 22:20:00"); // the name the pin was made with
	row("Sergeys-Mac-mini.local", MINI, "2026-10-15 23:22:50"); // the name the runner reconnects under
	row("pink-laptop", PINK, "2026-10-15 23:22:55"); // a different machine, also live
});
afterEach(() => d1.close());

async function open(body: Record<string, unknown> = { repoId: "r1" }) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", codingRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(`/v1/instances/${CODER}/coding/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, { DB: d1.DB, RELAY: relay } as unknown as Env);
	// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const sessionNode = () => d1.DB.prepare("SELECT runner_node FROM coding_sessions WHERE instance_id = ?1").bind(CODER).first<{ runner_node: string | null }>();

describe("waking a session on a pinned machine that reconnected under another name (#1102)", () => {
	it("opens on the live alias — the reported failure — and stamps the session with the name that answers", async () => {
		live.add(`${CODER}:node:Sergeys-Mac-mini.local`);
		live.add(`${CODER}:node:pink-laptop`);
		const r = await open();
		expect(r.status).toBe(201);
		expect(r.body.runnerConnected).toBe(true);
		expect((await sessionNode())?.runner_node).toBe("Sergeys-Mac-mini.local");
		// It started on the Mac mini, never on the other live machine.
		expect(commands.length).toBeGreaterThan(0);
		expect(commands.every((n) => n === `${CODER}:node:Sergeys-Mac-mini.local`)).toBe(true);
	});

	it("still uses the pinned name itself when that name holds the socket", async () => {
		live.add(`${CODER}:node:Macmini.modem`);
		live.add(`${CODER}:node:Sergeys-Mac-mini.local`);
		expect((await open()).status).toBe(201);
		expect((await sessionNode())?.runner_node).toBe("Macmini.modem");
	});

	it("refuses when no name of the pinned machine is live — never another machine that is", async () => {
		live.add(`${CODER}:node:pink-laptop`);
		const r = await open();
		expect(r.status).toBe(409);
		expect(r.body.error).toBe("Runner node is not connected: Macmini.modem");
		expect(await sessionNode()).toBeNull();
		expect(commands).toEqual([]);
	});

	it("never borrows liveness from a name it cannot prove is the same machine", async () => {
		d1.exec(`UPDATE instance_runtime_nodes SET machine_id = NULL WHERE runner_node = 'Macmini.modem'`);
		live.add(`${CODER}:node:Sergeys-Mac-mini.local`);
		const r = await open();
		expect(r.status).toBe(409);
		expect(await sessionNode()).toBeNull();
	});

	it("an explicitly requested node resolves the same way", async () => {
		d1.exec(`UPDATE agent_instances SET config = '{}' WHERE id = '${CODER}'`);
		live.add(`${CODER}:node:Sergeys-Mac-mini.local`);
		const r = await open({ repoId: "r1", runnerNode: "Macmini.modem" });
		expect(r.status).toBe(201);
		expect((await sessionNode())?.runner_node).toBe("Sergeys-Mac-mini.local");
	});
});
