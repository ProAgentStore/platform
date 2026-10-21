/**
 * #1174 — a pin on a machine's old hostname resolves to the same machine's live name by `machine_id`, however many other node
 * rows exist (it used to read the newest 200 and lose old spellings past that), and registrations unseen for 30 days expire.
 * Real migrated schema, relay stub.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../types.js";
import { type RealSchemaD1, realSchemaD1 } from "./d1-sqlite.js";
import { liveAliasForPin } from "./runner-client.js";
import { NODE_ROW_EXPIRY_DAYS, pruneStaleRuntimeNodes } from "./runtime-nodes.js";

let d1: RealSchemaD1;
let live: Set<string>;
let env: Env;
const MAC = "machine-mac-mini-0001";

beforeEach(() => {
	live = new Set();
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')");
	d1.exec("INSERT INTO agents (id, owner_id, slug, name) VALUES ('ag', 'u1', 't1174', 'A')");
	d1.exec("INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('inst-1', 'ag', 'u1', 'active', '{}'), ('inst-2', 'ag', 'u1', 'active', '{}')");
	env = {
		DB: d1.DB,
		RELAY: {
			idFromName: (n: string) => n,
			get: (name: string) => ({ fetch: async () => new Response(JSON.stringify({ connected: live.has(name.split(":node:")[1] ?? "") })) }),
		},
	} as unknown as Env;
});
afterEach(() => d1.close());

function node(instance: string, name: string, o: { machine?: string | null; updated?: string; seen?: string | null; user?: string } = {}) {
	d1.sqlite
		.prepare("INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, machine_id, status, last_seen_at, updated_at) VALUES (?, ?, ?, 'relay://', ?, 'registered', ?, ?)")
		.run(instance, o.user ?? "u1", name, o.machine ?? null, o.seen === undefined ? "2026-10-01 00:00:00" : o.seen, o.updated ?? "2026-10-01 00:00:00");
}
const count = () => (d1.sqlite.prepare("SELECT COUNT(*) AS n FROM instance_runtime_nodes").get() as { n: number }).n;

describe("alias lookup by machine id (#1174)", () => {
	it("finds the live spelling of a pinned machine even when 300 newer rows exist (the old LIMIT 200 lost it)", () => {
		node("inst-1", "Macmini", { machine: MAC, updated: "2026-01-01 00:00:00" }); // the abandoned spelling the pin names
		node("inst-1", "Mac-mini.local", { machine: MAC, updated: "2026-01-02 00:00:00", seen: "2026-10-20 00:00:00" });
		for (let i = 0; i < 300; i++) node("inst-1", `other-${i}`, { machine: `machine-other-${String(i).padStart(4, "0")}`, updated: "2026-10-15 00:00:00" });
		live.add("Mac-mini.local");
		return expect(liveAliasForPin(env, "inst-1", "u1", "Macmini")).resolves.toBe("Mac-mini.local");
	});

	it("reads only the pinned machine's rows: other machines' names are never offered as aliases", async () => {
		node("inst-1", "Macmini", { machine: MAC });
		node("inst-1", "Mac-mini.local", { machine: MAC });
		node("inst-1", "dell-laptop", { machine: "machine-dell-0000001" });
		live.add("dell-laptop");
		expect(await liveAliasForPin(env, "inst-1", "u1", "Macmini")).toBeNull(); // the Dell is live but is not the pinned machine
		live.add("Mac-mini.local");
		expect(await liveAliasForPin(env, "inst-1", "u1", "Macmini")).toBe("Mac-mini.local");
	});

	it("resolves through another instance's row when only that one carries the machine id under the pinned name", async () => {
		node("inst-2", "Macmini", { machine: MAC });
		node("inst-1", "Mac-mini.local", { machine: MAC });
		live.add("Mac-mini.local");
		expect(await liveAliasForPin(env, "inst-1", "u1", "Macmini")).toBe("Mac-mini.local");
	});

	it("a pinned name with no recorded machine id resolves to nothing (a name is not an identity)", async () => {
		node("inst-1", "Macmini", { machine: null });
		node("inst-1", "Mac-mini.local", { machine: null });
		live.add("Mac-mini.local");
		expect(await liveAliasForPin(env, "inst-1", "u1", "Macmini")).toBeNull();
	});

	it("is owner-scoped: another owner's rows with the same machine id are not aliases", async () => {
		node("inst-1", "Macmini", { machine: MAC });
		d1.exec("INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('inst-9', 'ag', 'u2', 'active', '{}')");
		node("inst-9", "their-box", { machine: MAC, user: "u2" });
		live.add("their-box");
		expect(await liveAliasForPin(env, "inst-1", "u1", "Macmini")).toBeNull();
	});
});

describe("expiring unseen machine registrations (#1174)", () => {
	it("removes rows unseen for 30 days, keeps recent ones, and falls back to updated_at when a row never recorded a sighting", async () => {
		node("inst-1", "ancient", { seen: "2025-01-01 00:00:00", updated: "2025-01-01 00:00:00" });
		node("inst-1", "never-seen-old", { seen: null, updated: "2025-01-01 00:00:00" });
		node("inst-1", "never-seen-new", { seen: null, updated: new Date().toISOString().replace("T", " ").slice(0, 19) });
		node("inst-1", "fresh", { seen: new Date().toISOString().replace("T", " ").slice(0, 19) });
		const removed = await pruneStaleRuntimeNodes(env);
		expect(removed).toBe(2);
		expect((d1.sqlite.prepare("SELECT runner_node FROM instance_runtime_nodes ORDER BY runner_node").all() as Array<{ runner_node: string }>).map((r) => r.runner_node)).toEqual(["fresh", "never-seen-new"]);
	});

	it("the window is 30 days: 29 days old stays, 31 days old goes", async () => {
		const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
		node("inst-1", "d29", { seen: ago(29) });
		node("inst-1", "d31", { seen: ago(31) });
		expect(NODE_ROW_EXPIRY_DAYS).toBe(30);
		await pruneStaleRuntimeNodes(env);
		expect(count()).toBe(1);
		expect((d1.sqlite.prepare("SELECT runner_node FROM instance_runtime_nodes").get() as { runner_node: string }).runner_node).toBe("d29");
	});

	it("touches only node rows: the default runtime row is left alone", async () => {
		d1.exec("INSERT INTO instance_runtimes (instance_id, user_id, placement, endpoint_url, runner_node, status, last_seen_at, updated_at) VALUES ('inst-1', 'u1', 'local', 'http://127.0.0.1:1', 'old', 'registered', '2025-01-01 00:00:00', '2025-01-01 00:00:00')");
		node("inst-1", "ancient", { seen: "2025-01-01 00:00:00" });
		await pruneStaleRuntimeNodes(env);
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM instance_runtimes").get() as { n: number }).n).toBe(1);
		expect(count()).toBe(0);
	});
});
