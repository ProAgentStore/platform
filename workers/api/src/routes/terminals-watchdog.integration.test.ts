/** #1320 end to end over the real schema: the owner queues a command, the watchdog's heartbeat receives it and answers it. */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { terminalRoutes } = await import("./terminals.js");

const MID = "laptop-0000-machine-id";
let d1: RealSchemaD1;
beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag', 'u1', 't1320', 'Coder', '{}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i-a', 'ag', 'u1', 'active', '{}')`);
	d1.exec(`INSERT INTO instance_runtimes (instance_id, user_id, endpoint_url, runner_node, status) VALUES ('i-a', 'u1', 'relay://', 'Laptop', 'online')`);
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, status, last_seen_at) VALUES ('i-a', 'u1', 'Laptop', 'relay://', '0.4.177', '${MID}', 'online', '2026-10-23 00:00:00')`);
});
afterEach(() => d1.close());

const app = () => {
	const a = new Hono<{ Bindings: Env }>();
	a.route("/v1/terminals", terminalRoutes);
	a.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	return a;
};
// biome-ignore lint/suspicious/noExplicitAny: responses are read field by field
type Body = Record<string, any>;
async function call(method: string, path: string, body?: unknown) {
	const res = await app().request(`/v1/terminals/machines/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, { DB: d1.DB } as unknown as Env);
	return { status: res.status, json: (await res.json()) as Body };
}
const beat = (extra: Record<string, unknown> = {}) => call("POST", `${MID}/watchdog/heartbeat`, { version: "0.4.177", ...extra });

describe("the watchdog control channel over HTTP (#1320)", () => {
	it("a machine this account never registered is a 404 on all three routes", async () => {
		for (const [m, p, b] of [["POST", "stranger-machine-id-0/watchdog/heartbeat", {}], ["GET", "stranger-machine-id-0/watchdog", undefined], ["POST", "stranger-machine-id-0/watchdog/commands", { kind: "restart" }]] as const) {
			expect((await call(m, p, b)).status).toBe(404);
		}
	});
	it("a command cannot be queued before a watchdog has ever reported", async () => {
		const r = await call("POST", `${MID}/watchdog/commands`, { kind: "restart" });
		expect(r.status).toBe(409);
		expect(r.json.error).toMatch(/no watchdog yet/);
	});
	it("queue → heartbeat delivers it → the next heartbeat settles it with the watchdog's result", async () => {
		await beat();
		const q = await call("POST", `${MID}/watchdog/commands`, { kind: "restart" });
		expect(q.status).toBe(201);
		const id = q.json.command.id as string;
		expect((await call("POST", `${MID}/watchdog/commands`, { kind: "restart" })).json.duplicate).toBe(true); // not doubled
		const delivered = await beat();
		expect(delivered.json.commands.map((c: Body) => c.id)).toEqual([id]);
		await beat({ results: [{ id, state: "done", detail: "restarted" }] });
		const read = await call("GET", `${MID}/watchdog`);
		expect(read.json).toMatchObject({ installed: true, connected: true });
		expect(read.json.commands[0]).toMatchObject({ id, state: "done" });
	});
	it("a kind outside the closed set is refused", async () => {
		await beat();
		expect((await call("POST", `${MID}/watchdog/commands`, { kind: "rm-rf" })).status).toBe(400);
	});
});
