/**
 * #1528 — `coding_session_fresh` handed back the SAME session ("reused: true") after a turn timeout instead of clearing the
 * corrupt history.
 *
 * The live state: a direct turn hit its 15-minute limit; the capture then read runState `idle`, an ACTIVE session, ownership
 * empty — a session that looks healthy to every liveness check but whose pane kept reporting a missing custom tool output. An
 * explicit fresh returned the same session id with `resumed: true`, so the corrupt conversation survived the call that exists
 * to remove it. Over the real schema; only the relay is faked: which `<instance>:node:<name>` slots hold a socket, and what a
 * command returns.
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
const NODE = "pink-laptop";
let d1: RealSchemaD1;
let live: Set<string>;
let commands: Array<{ node: string; path: string; body: Record<string, unknown> }>;
const relay = {
	idFromName: (n: string) => n,
	get: (name: string) => ({
		fetch: async (req: Request) => {
			if (req.url.endsWith("/status")) return Response.json({ connected: live.has(name) });
			if (!live.has(name)) return new Response("no socket", { status: 503 });
			const sent = (await req.json().catch(() => ({}))) as { path?: string; body?: Record<string, unknown> };
			commands.push({ node: name, path: sent.path ?? new URL(req.url).pathname, body: sent.body ?? {} });
			return Response.json({ ok: true });
		},
	}),
};

beforeEach(() => {
	d1 = realSchemaD1();
	live = new Set([`${CODER}:node:${NODE}`]);
	commands = [];
	seedTenant(d1, { userId: "u1", instanceIds: [CODER] });
	d1.exec(`UPDATE agent_instances SET config = '{"runnerNode":"${NODE}"}' WHERE id = '${CODER}'`);
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r1', '${CODER}', 'u1', 'ProAgentStore/platform', '/w/platform', 'ready')`);
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, status, last_seen_at)
	         VALUES ('${CODER}', 'u1', '${NODE}', 'relay://', '0.4.214', 'm-pink', 'online', '2026-11-04 19:10:00')`);
	// The wedged session: ACTIVE, idle, on the live machine — what a timed-out direct turn leaves behind.
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, user_id, repo_id, client_type, status, runner_node) VALUES ('csess_old', '${CODER}', 'u1', 'r1', 'codex', 'active', '${NODE}')`);
});
afterEach(() => d1.close());

async function call(method: string, path: string, body?: Record<string, unknown>) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", codingRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(`/v1/instances/${CODER}${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }, { DB: d1.DB, RELAY: relay } as unknown as Env);
	// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const rows = () => d1.DB.prepare("SELECT id, status FROM coding_sessions WHERE instance_id = ?1 ORDER BY id").bind(CODER).all<{ id: string; status: string }>().then((r) => r.results ?? []);

describe("an explicit fresh never reuses the live session (#1528)", () => {
	it("THE REPORTED FAILURE: fresh with the idle-but-active session still in place is refused, not answered `reused: true`", async () => {
		const r = await call("POST", "/coding/sessions", { repoId: "r1", fresh: true });
		expect(r.status).toBe(409);
		expect(r.body).toMatchObject({ code: "fresh_requires_end", activeSessionId: "csess_old", reused: false });
		expect(r.body.error).toMatch(/still active/);
		expect(r.body.error).toMatch(/End it first/);
		// Nothing was reattached, restarted or created: the old conversation is exactly as it was.
		expect(commands).toEqual([]);
		expect(await rows()).toEqual([{ id: "csess_old", status: "active" }]);
	});

	it("CONTROL: a plain open of the same repo still reuses it — only an explicit fresh changed", async () => {
		const r = await call("POST", "/coding/sessions", { repoId: "r1" });
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ reused: true, session: { id: "csess_old" } });
	});

	it("timed-out turn → idle ACTIVE session → end → fresh: a genuinely new session, no old history, one active", async () => {
		const ended = await call("POST", "/coding/sessions/csess_old/end");
		expect(ended.status).toBe(200);
		expect(ended.body).toMatchObject({ ok: true, session: "ended", engineStopped: true });
		// The runner was asked to stop THAT session's engine before anything else started.
		expect(commands.find((c) => c.path.endsWith("/coding/end"))?.body).toMatchObject({ sessionId: "csess_old" });

		const fresh = await call("POST", "/coding/sessions", { repoId: "r1", fresh: true });
		expect(fresh.status).toBe(201);
		expect(fresh.body.reused).toBeUndefined();
		expect(fresh.body.session.id).not.toBe("csess_old");
		// The conversation is new: the continuity decision says so, and nothing was resumed.
		expect(fresh.body.continuity?.mode).toBe("fresh");
		expect(fresh.body.resumed).not.toBe(true);
		// The checkout is a separate thing and is never touched here; the old row is closed, the new one is the only active one.
		const all = await rows();
		expect(all.find((s) => s.id === "csess_old")?.status).toBe("ended");
		expect(all.filter((s) => s.status === "active")).toHaveLength(1);
		expect(all.find((s) => s.status === "active")?.id).toBe(fresh.body.session.id);
	});

	it("a fresh with NO session in the way opens one, as before", async () => {
		d1.exec(`UPDATE coding_sessions SET status = 'ended' WHERE id = 'csess_old'`);
		const r = await call("POST", "/coding/sessions", { repoId: "r1", fresh: true });
		expect(r.status).toBe(201);
		expect(r.body.continuity?.mode).toBe("fresh");
	});

	it("another repo's active session is not in the way of this repo's fresh", async () => {
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r2', '${CODER}', 'u1', 'ProAgentStore/other', '/w/other', 'ready')`);
		d1.exec(`UPDATE coding_sessions SET status = 'ended' WHERE id = 'csess_old'`);
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, user_id, repo_id, client_type, status, runner_node) VALUES ('csess_other', '${CODER}', 'u1', 'r2', 'codex', 'active', '${NODE}')`);
		const r = await call("POST", "/coding/sessions", { repoId: "r1", fresh: true });
		expect(r.status).toBe(201);
		expect((await rows()).find((s) => s.id === "csess_other")?.status).toBe("active");
	});
});
