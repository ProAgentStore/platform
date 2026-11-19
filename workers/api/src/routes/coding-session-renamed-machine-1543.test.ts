/**
 * #1543 — a session's commands follow a RENAMED machine, and still refuse every machine that is not provably the same one.
 *
 * Live state on 2026-11-05: the owner named physical machine 8de74159… `macmini` everywhere. The registry kept `Macmini.modem` and
 * `Sergeys-Mac-mini.local` as aliases of that id; the machine was up and responsive as `macmini`. A session stamped to the old
 * name was then sent `coding_session_message`, and the shared session resolver (exact stamp only) answered "No coding runner
 * connected. Start it with: pags up" — to an owner whose runner was already running. #1541 fixed that for `/end` alone.
 *
 * Over the real schema; only the relay is faked: which `<instance>:node:<name>` slots hold a socket, and what a command returns.
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
const OTHER_INSTANCE = "b2c3d4e5-0000-4000-8000-000000000002";
const THIRD_OWNER_INSTANCE = "c3d4e5f6-0000-4000-8000-000000000003";
const MINI = "8de74159-5e07-4e44-8472-56cc7b728cef";
const PINK = "e4fdf96a-0ebc-4dd6-bbd1-1f3a4b69599e";
const SESSION = "csess_a1ea1a4c";
let d1: RealSchemaD1;
let live: Set<string>;
/** When set, ONLY the owner-wide machine-identity read fails — every ordinary per-node lookup still works. */
let registryDown = false;
let commands: Array<{ node: string; path: string }>;
const relay = {
	idFromName: (n: string) => n,
	get: (name: string) => ({
		fetch: async (req: Request) => {
			if (req.url.endsWith("/status")) return Response.json({ connected: live.has(name) });
			if (!live.has(name)) return new Response("no socket", { status: 503 });
			const sent = (await req.json().catch(() => ({}))) as { path?: string };
			commands.push({ node: name, path: sent.path ?? new URL(req.url).pathname });
			return Response.json({ ok: true });
		},
	}),
};
const slot = (node: string, instance = CODER) => `${instance}:node:${node}`;

const register = (node: string, machine: string | null, opts: { user?: string; instance?: string; seen?: string } = {}) =>
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, status, last_seen_at)
	         VALUES ('${opts.instance ?? CODER}', '${opts.user ?? "u1"}', '${node}', 'relay://', '0.4.221', ${machine ? `'${machine}'` : "NULL"}, 'online', '${opts.seen ?? "2026-11-05 03:00:00"}')`);

beforeEach(() => {
	d1 = realSchemaD1();
	live = new Set();
	commands = [];
	registryDown = false;
	seedTenant(d1, { userId: "u1", instanceIds: [CODER, OTHER_INSTANCE] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r1', '${CODER}', 'u1', 'ProAgentStore/platform', '/w/platform', 'ready')`);
	// The session was opened on the machine under the name it had THEN.
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, user_id, repo_id, client_type, status, runner_node) VALUES ('${SESSION}', '${CODER}', 'u1', 'r1', 'codex', 'active', 'Macmini.modem')`);
});
afterEach(() => d1.close());

/** The real database, with the one identity query able to fail on demand. */
function db(): D1Database {
	return new Proxy(d1.DB, {
		get: (target, key) => {
			if (key !== "prepare") return Reflect.get(target, key, target).bind?.(target) ?? Reflect.get(target, key, target);
			return (sql: string) => {
				if (registryDown && /FROM instance_runtime_nodes WHERE user_id = \?1 ORDER BY/.test(sql)) throw new Error("registry unavailable");
				return target.prepare(sql);
			};
		},
	}) as D1Database;
}

async function call(method: string, path: string, body?: Record<string, unknown>) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", codingRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(`/v1/instances/${CODER}${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }, { DB: db(), RELAY: relay, CODING_SESSION: { create: async () => ({ id: "cw" }) } } as unknown as Env);
	// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
	return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}
const message = () => call("POST", `/coding/sessions/${SESSION}/message`, { text: "finish the parked run" });
const restart = () => call("POST", `/coding/sessions/${SESSION}/restart`);
const reattach = () => call("POST", `/coding/sessions/${SESSION}/start`);
const sentTo = () => [...new Set(commands.map((c) => c.node))];

describe("a renamed, responsive machine is reached by every command addressed to its session (#1543)", () => {
	beforeEach(() => {
		register("Macmini.modem", MINI, { seen: "2026-11-04 20:00:00" }); // the name the session was stamped with
		register("Sergeys-Mac-mini.local", MINI, { seen: "2026-11-05 01:00:00" });
		register("macmini", MINI, { seen: "2026-11-05 03:00:00" }); // the name it answers to now
		live.add(slot("macmini"));
	});

	it("THE REPORTED FAILURE: /message reaches the machine under its new name instead of 'No coding runner connected'", async () => {
		const r = await message();
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		expect(sentTo()).toEqual([slot("macmini")]);
	});

	it("/restart and the re-attach /start follow the same proven identity", async () => {
		expect((await restart()).status).toBe(200);
		expect((await reattach()).status).toBe(200);
		expect(sentTo()).toEqual([slot("macmini")]);
	});

	it("the CURRENT PIN does not decide it: a pin elsewhere changes nothing about where the stamped session goes", async () => {
		register("pink-laptop", PINK);
		live.add(slot("pink-laptop"));
		d1.exec(`UPDATE agent_instances SET config = '{"runnerNode":"pink-laptop"}' WHERE id = '${CODER}'`);
		expect((await message()).status).toBe(200);
		expect(sentTo()).toEqual([slot("macmini")]);
		expect(commands.some((c) => c.node === slot("pink-laptop"))).toBe(false);
	});

	it("the exact stamped name still wins when it is itself the live one", async () => {
		live.add(slot("Macmini.modem"));
		expect((await message()).status).toBe(200);
		expect(commands.every((c) => c.node === slot("Macmini.modem"))).toBe(true);
	});

	it("an unreadable registry never throws and never invents an alias: the exact stamp is tried, and an alias-only machine is refused", async () => {
		registryDown = true;
		// `macmini` is live but nothing PROVES it is the stamped machine now — the same refusal as an unrelated machine.
		const r = await message();
		expect(r.status).toBe(409);
		expect(commands).toEqual([]);
		// …while the exact stamped name, live, is reached exactly as it always was.
		live.add(slot("Macmini.modem"));
		expect((await message()).status).toBe(200);
		expect(sentTo()).toEqual([slot("Macmini.modem")]);
	});
});

describe("nothing is sent to a machine that is not provably the stamped one (#1543)", () => {
	it("a DIFFERENT machine that is up is never a fallback, and the refusal names the truth, not 'start pags up'", async () => {
		register("Macmini.modem", MINI);
		register("pink-laptop", PINK);
		live.add(slot("pink-laptop"));
		const r = await message();
		expect(r.status).toBe(409);
		expect(commands).toEqual([]);
		expect(r.body.error).toMatch(/No coding runner connected for this session/);
		expect(r.body.error).toMatch(/Macmini\.modem/);
		expect(r.body.error).toMatch(/pink-laptop/);
		expect(r.body.error).toMatch(/Nothing was sent/);
		expect(r.body.error).not.toMatch(/Run `pags up`/);
	});

	it("the original machine OFFLINE and nothing else up is refused with nothing sent", async () => {
		register("Macmini.modem", MINI);
		register("macmini", MINI);
		const r = await message();
		expect(r.status).toBe(409);
		expect(commands).toEqual([]);
		expect(r.body.error).toMatch(/Nothing was sent/);
	});

	it("an AMBIGUOUS name — two machine ids ever recorded under it — is refused even when that exact name is live", async () => {
		register("Macmini.modem", MINI);
		// The same NAME on another instance of this owner, recorded against a different physical machine: two real machines
		// have answered to it, so which one is live now proves nothing about which one this session meant.
		register("Macmini.modem", PINK, { instance: OTHER_INSTANCE, seen: "2026-11-05 02:00:00" });
		live.add(slot("Macmini.modem"));
		const r = await message();
		expect(r.status).toBe(409);
		expect(commands).toEqual([]);
		expect((await restart()).status).toBe(409);
		expect(commands).toEqual([]);
	});

	it("another OWNER's registration of the same machine id proves nothing for this owner", async () => {
		seedTenant(d1, { userId: "u2", instanceIds: [THIRD_OWNER_INSTANCE] });
		register("Macmini.modem", MINI);
		// A different owner registered an alias under the same physical id — it is not this owner's evidence.
		register("intruder-alias", MINI, { user: "u2", instance: THIRD_OWNER_INSTANCE });
		live.add(slot("intruder-alias"));
		const r = await message();
		expect(r.status).toBe(409);
		expect(commands).toEqual([]);
	});

	it("an alias recorded for a DIFFERENT instance of this owner is still this owner's proof, but its socket must be this instance's", async () => {
		register("Macmini.modem", MINI);
		register("macmini", MINI, { instance: OTHER_INSTANCE });
		// The alias name is live for the OTHER instance only; this instance has no socket under it.
		live.add(slot("macmini", OTHER_INSTANCE));
		const r = await message();
		expect(r.status).toBe(409);
		expect(commands).toEqual([]);
	});

	it("a LEGACY stamp with no machine id anywhere still routes by its exact name, as before", async () => {
		register("Macmini.modem", null);
		live.add(slot("Macmini.modem"));
		expect((await message()).status).toBe(200);
		expect(sentTo()).toEqual([slot("Macmini.modem")]);
	});

	it("a legacy stamp with no id does not borrow an alias it cannot prove", async () => {
		register("Macmini.modem", null);
		register("macmini", MINI);
		live.add(slot("macmini"));
		expect((await message()).status).toBe(409);
		expect(commands).toEqual([]);
	});
});
