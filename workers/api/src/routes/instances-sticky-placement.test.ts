/**
 * #1173 — an unpinned agent registered by two machines used to be served by whichever registered LAST (the default
 * runtime row was overwritten on every registration). Placement is now sticky: a second machine registers its own node row
 * but leaves the default row with the machine that still holds a live relay socket; it takes over when that one is gone, or on
 * an explicit --force takeover. Through the real route against the real migrated schema.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { type RealSchemaD1, realSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }), requirePro: async () => undefined };
});
const { instanceRoutes } = await import("./instances.js");
const { holdsDefaultRow } = await import("./instances-runtime.js");

let d1: RealSchemaD1;
/** Relay slots that currently hold a live socket, by node name. */
let live: Set<string>;

const relay = {
	idFromName: (n: string) => n,
	get: (name: string) => ({
		fetch: async () => {
			const node = name.includes(":node:") ? name.split(":node:")[1] : "";
			return new Response(JSON.stringify({ connected: live.has(node) }));
		},
	}),
};

beforeEach(() => {
	live = new Set();
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'u1')");
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag', 'u1', 't1173', 'Coder', '{"capabilities":{"surfaces":["coding"],"runtime":"coding"}}')`);
	d1.exec("INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('inst-1', 'ag', 'u1', 'active', '{}')");
});
afterEach(() => d1.close());

async function register(node: string, over: Record<string, unknown> = {}) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(
		"/v1/instances/inst-1/runtime",
		{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpointUrl: `http://127.0.0.1:${node === "mac" ? 1111 : 2222}`, runnerNode: node, runnerVersion: "0.4.173", ...over }) },
		{ DB: d1.DB, RELAY: relay } as unknown as Env,
	);
	expect(res.status).toBe(201);
}
const defaultRow = () => d1.sqlite.prepare("SELECT runner_node, endpoint_url FROM instance_runtimes WHERE instance_id = 'inst-1'").get() as { runner_node: string; endpoint_url: string };
const nodeRows = () => (d1.sqlite.prepare("SELECT runner_node FROM instance_runtime_nodes WHERE instance_id = 'inst-1' ORDER BY runner_node").all() as Array<{ runner_node: string }>).map((r) => r.runner_node);

describe("sticky placement for an unpinned agent (#1173)", () => {
	it("the first machine to register holds the default row", async () => {
		await register("mac");
		expect(defaultRow()).toEqual({ runner_node: "mac", endpoint_url: "http://127.0.0.1:1111" });
	});

	it("a second machine registering while the first is connected does NOT take the default row — but is registered and addressable", async () => {
		await register("mac");
		live.add("mac");
		await register("dell");
		expect(defaultRow().runner_node).toBe("mac");
		expect(nodeRows()).toEqual(["dell", "mac"]);
	});

	it("reconnect order no longer decides: the holder re-registering keeps it, and the other machine re-registering again changes nothing", async () => {
		await register("mac");
		live.add("mac");
		await register("dell");
		await register("mac");
		await register("dell");
		await register("dell");
		expect(defaultRow().runner_node).toBe("mac");
	});

	it("failover by design: when the holder is no longer connected, the registering machine takes over", async () => {
		await register("mac");
		live.add("mac");
		await register("dell");
		live.delete("mac"); // the Mac went away
		await register("dell");
		expect(defaultRow()).toEqual({ runner_node: "dell", endpoint_url: "http://127.0.0.1:2222" });
	});

	it("an explicit --force takeover claims the default row even from a live holder", async () => {
		await register("mac");
		live.add("mac");
		await register("dell", { force: true });
		expect(defaultRow().runner_node).toBe("dell");
	});

	it("a registration with no node (an older CLI) is the default runtime as before", async () => {
		await register("mac");
		live.add("mac");
		await register("", { runnerNode: "" });
		expect(defaultRow().endpoint_url).toBe("http://127.0.0.1:2222");
	});
});

describe("holdsDefaultRow", () => {
	it("holds only for a different, live holder with no force", () => {
		const prev = { runner_node: "mac" };
		expect(holdsDefaultRow(prev, "dell", false, true)).toBe(true);
		expect(holdsDefaultRow(prev, "dell", true, true)).toBe(false);
		expect(holdsDefaultRow(prev, "dell", false, false)).toBe(false);
		expect(holdsDefaultRow(prev, "mac", false, true)).toBe(false);
		expect(holdsDefaultRow(prev, "", false, true)).toBe(false);
		expect(holdsDefaultRow(null, "dell", false, true)).toBe(false);
		expect(holdsDefaultRow({ runner_node: "" }, "dell", false, true)).toBe(false);
	});
});
