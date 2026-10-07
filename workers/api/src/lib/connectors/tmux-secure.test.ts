/**
 * The machine-to-machine secret handoff (#918): machine A's tmux Operator PUTs a file, machine B's
 * GETs it — and the value appears in NOTHING the model, the console or the database can show.
 *
 * Run against the real schema (every migration, foreign keys on) and through `runRegistryTool`, the
 * one path chat, `/tools`, MCP and pipelines all share, so the consent gate and the dispatcher's own
 * bookkeeping are inside what is checked. Only the relay is faked: a map of files per machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getBoundRunnerConn, callRunner } = vi.hoisted(() => ({ getBoundRunnerConn: vi.fn(), callRunner: vi.fn() }));
vi.mock("../runner-client.js", () => ({ getBoundRunnerConn, callRunner, READ_TIMEOUT_MS: 10_000 }));

import { runRegistryTool } from "../tool-registry.js";
import { consumeSecureInput, countSecureInputRequests, getSecureInputStatus, listSecureInputRequests } from "../secure-input.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../d1-sqlite.js";
import { SECURE_HANDOFF_MIN_CLI } from "./tmux.js";
import type { Env } from "../../types.js";

const SECRET = "FIREBASE_API_KEY=AIzaSy-HANDOFF-PLAINTEXT-7f3a\nSERVER_KEY=sk_live_HANDOFF-PLAINTEXT-91c2\n";
/** Distinctive fragments: finding either anywhere outside a file is the leak. */
const NEEDLES = ["HANDOFF-PLAINTEXT", "AIzaSy"];

const NODE = { A: "mac-mini", B: "pink-laptop", C: "strangers-box" } as Record<string, string>;
/** Fake disks, per machine. */
let disks: Record<string, Map<string, string>>;
/** Every command sent to a runner — the relay, the one place the value is ALLOWED to travel. */
let relayed: { node: string; path: string; body: unknown }[];
let runnerTooOld: Set<string>;
let failWritesOn: Set<string>;

let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "owner", instanceIds: ["A", "B"] });
	seedTenant(d1, { userId: "stranger", instanceIds: ["C"] });
	for (const [i, u] of [["A", "owner"], ["B", "owner"], ["C", "stranger"]]) {
		d1.exec(`INSERT INTO instance_connector_consent (instance_id, user_id, connector, scope) VALUES ('${i}', '${u}', 'tmux', 'write')`);
	}
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: "0".repeat(64) } as unknown as Env;
	disks = { [NODE.A]: new Map([["/home/owner/app/.env.prod", SECRET]]), [NODE.B]: new Map(), [NODE.C]: new Map() };
	relayed = [];
	runnerTooOld = new Set();
	failWritesOn = new Set();
	getBoundRunnerConn.mockReset();
	callRunner.mockReset();
	getBoundRunnerConn.mockImplementation(async (_env: unknown, instanceId: string) => ({ runnerNode: NODE[instanceId], instanceId }));
	callRunner.mockImplementation(async (conn: { runnerNode: string }, path: string, body: Record<string, unknown>) => {
		const node = conn.runnerNode;
		relayed.push({ node, path, body });
		if (runnerTooOld.has(node)) throw new Error(`Runner ${path} → 404: {"error":"Not found"}`);
		const disk = disks[node];
		if (path === "/secure/read") {
			const value = disk.get(String(body.path));
			if (value == null) throw new Error(`Runner ${path} → 400: {"error":"No file at ${body.path}."}`);
			return { path: body.path, value, bytes: Buffer.byteLength(value) };
		}
		if (path === "/secure/write") {
			if (failWritesOn.has(node)) throw new Error(`Runner ${path} → 400: {"error":"${body.path} already exists. Pass overwrite: true to replace it."}`);
			disk.set(String(body.path), String(body.value));
			return { path: body.path, bytes: Buffer.byteLength(String(body.value)), replaced: false };
		}
		throw new Error(`unexpected runner path ${path}`);
	});
});
afterEach(() => d1.close());

const run = (instanceId: string, tool: string, input: Record<string, unknown>) =>
	runRegistryTool(tool, { env, userId: instanceId === "C" ? "stranger" : "owner", agentId: "agent-1", instanceId }, input);

const put = () => run("A", "tmux_secure_put", { path: "/home/owner/app/.env.prod", label: "heartfull .env.prod" });

/** Every text value in every table, plus every string the database was handed. */
function everythingTheDatabaseSaw(): string {
	const tables = d1.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
	const parts: string[] = [];
	for (const { name } of tables) {
		for (const row of d1.sqlite.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]) {
			for (const v of Object.values(row)) parts.push(v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : String(v));
		}
	}
	for (const s of d1.issued) for (const b of s.binds) if (typeof b === "string") parts.push(b);
	return parts.join("\n");
}

function expectNoPlaintext(text: string): void {
	for (const n of NEEDLES) expect(text).not.toContain(n);
}

describe("tmux_secure_put → tmux_secure_get across two of the owner's machines (#918)", () => {
	it("moves the file byte-for-byte, and the value is in no tool result and nowhere in the database", async () => {
		const p = await put();
		expect(p.success).toBe(true);
		expectNoPlaintext(p.content);
		const deposit = JSON.parse(p.content) as { handle: string; status: string; sourceNode: string; consoleUrl: string; bytes: number };
		expect(deposit).toMatchObject({ status: "ready", sourceNode: NODE.A, bytes: Buffer.byteLength(SECRET) });
		expect(deposit.consoleUrl).toBe(`/instances/A/secure-inputs/${deposit.handle}`);
		expectNoPlaintext(everythingTheDatabaseSaw());

		const g = await run("B", "tmux_secure_get", { handle: deposit.handle, path: "/home/owner/app/.env.prod" });
		expect(g.success).toBe(true);
		expectNoPlaintext(g.content);
		expect(JSON.parse(g.content)).toMatchObject({ handle: deposit.handle, status: "consumed", node: NODE.B, bytes: Buffer.byteLength(SECRET) });
		expect(disks[NODE.B].get("/home/owner/app/.env.prod")).toBe(SECRET);
		expectNoPlaintext(everythingTheDatabaseSaw());

		// The value travelled only where it had to: A's read reply and B's write request. Never a tmux path.
		expect(relayed.map((r) => `${r.node} ${r.path}`)).toEqual([`${NODE.A} /secure/read`, `${NODE.B} /secure/write`]);
	});

	it("shows the owner metadata only — where it came from, where it went — in the console's views", async () => {
		const { handle } = JSON.parse((await put()).content) as { handle: string };
		const listed = await listSecureInputRequests(env, "A", "owner");
		expect(listed).toEqual([expect.objectContaining({ id: handle, status: "ready", label: "heartfull .env.prod", sourceNode: NODE.A, kind: "deposit" })]);
		expectNoPlaintext(JSON.stringify(listed));

		await run("B", "tmux_secure_get", { handle, path: "/x/.env" });
		const after = await getSecureInputStatus(env, handle, "A", "owner");
		expect(after).toMatchObject({ status: "consumed", sourceNode: NODE.A, consumedNode: NODE.B });
		expectNoPlaintext(JSON.stringify(after));
		// Consumed handles leave the pending list, which is what the console's banner reads.
		expect(await listSecureInputRequests(env, "A", "owner")).toEqual([]);
	});

	it("lists a page of requests with the instance's total, so the newest 20 never read as all of them (#954)", async () => {
		for (let i = 0; i < 23; i++) {
			d1.exec(
				`INSERT INTO secure_input_requests (id, instance_id, user_id, status, label, destination_scope, expires_at, created_at) VALUES ('req-${String(i).padStart(2, "0")}', 'A', 'owner', 'pending', 'code ${i}', 'tmux', '2999-01-01T00:00:00Z', '2026-10-07 00:00:${String(i).padStart(2, "0")}')`,
			);
		}
		const first = await listSecureInputRequests(env, "A", "owner");
		expect(first).toHaveLength(20);
		expect(first[0].id).toBe("req-22");
		expect(await countSecureInputRequests(env, "A", "owner")).toBe(23);
		expect((await listSecureInputRequests(env, "A", "owner", 20, 20)).map((r) => r.id)).toEqual(["req-02", "req-01", "req-00"]);
		// Another owner's instance is neither listed nor counted.
		expect(await countSecureInputRequests(env, "C", "owner")).toBe(0);
		// The history (#929 finding 8): a consumed request leaves the open list but not `all`.
		d1.exec("UPDATE secure_input_requests SET status = 'consumed' WHERE id = 'req-22'");
		expect(await countSecureInputRequests(env, "A", "owner")).toBe(22);
		expect(await countSecureInputRequests(env, "A", "owner", true)).toBe(23);
		expect((await listSecureInputRequests(env, "A", "owner", 1, 0, true))[0]).toMatchObject({ id: "req-22", status: "consumed" });
	});

	it("a deposit from a connection with no node name is still a deposit, and an owner request is not (#929)", async () => {
		const { depositSecureInput, createSecureInputRequest } = await import("../secure-input.js");
		const { id } = await depositSecureInput(env, { instanceId: "A", userId: "owner", label: "nameless", sourceNode: null, ttlMs: 60_000, value: "v" });
		const owner = await createSecureInputRequest(env, { instanceId: "A", userId: "owner", label: "code", destinationScope: "tmux" });
		expect(await getSecureInputStatus(env, id, "A", "owner")).toMatchObject({ kind: "deposit" });
		expect((await getSecureInputStatus(env, id, "A", "owner"))?.sourceNode).toBeUndefined();
		expect(await getSecureInputStatus(env, owner, "A", "owner")).toMatchObject({ kind: "owner" });
	});

	it("is one-shot: a second get of the same handle writes nothing", async () => {
		const { handle } = JSON.parse((await put()).content) as { handle: string };
		expect((await run("B", "tmux_secure_get", { handle, path: "/one" })).success).toBe(true);
		const again = await run("A", "tmux_secure_get", { handle, path: "/two" });
		expect(again.success).toBe(false);
		expect(again.content).toMatch(/not ready/);
		expect(disks[NODE.A].has("/two")).toBe(false);
	});

	it("only ever releases a value once, even to two gets racing for it", async () => {
		const { handle } = JSON.parse((await put()).content) as { handle: string };
		const both = await Promise.all([consumeSecureInput(env, handle, null, "owner"), consumeSecureInput(env, handle, null, "owner")]);
		expect(both.filter((v) => v === SECRET)).toHaveLength(1);
		expect(both.filter((v) => v === null)).toHaveLength(1);
	});

	it("will not hand one owner's secret to another owner's machine", async () => {
		const { handle } = JSON.parse((await put()).content) as { handle: string };
		const stolen = await run("C", "tmux_secure_get", { handle, path: "/loot" });
		expect(stolen.success).toBe(false);
		expect(disks[NODE.C].size).toBe(0);
		expect((await getSecureInputStatus(env, handle, "A", "owner"))?.status).toBe("ready");
	});

	it("puts the handle back when the destination cannot be written, so the owner can retry", async () => {
		const { handle } = JSON.parse((await put()).content) as { handle: string };
		failWritesOn.add(NODE.B);
		const failed = await run("B", "tmux_secure_get", { handle, path: "/home/owner/app/.env.prod" });
		expect(failed.success).toBe(false);
		expect(failed.content).toMatch(/already exists/);
		expect(failed.content).toMatch(/still ready/);
		expectNoPlaintext(failed.content);
		expect((await getSecureInputStatus(env, handle, "A", "owner"))?.status).toBe("ready");

		failWritesOn.clear();
		expect((await run("B", "tmux_secure_get", { handle, path: "/home/owner/app/.env.prod" })).success).toBe(true);
		expect(disks[NODE.B].get("/home/owner/app/.env.prod")).toBe(SECRET);
		expectNoPlaintext(everythingTheDatabaseSaw());
	});

	it("names the CLI release an old runner needs, instead of a raw 404 — and spends nothing", async () => {
		runnerTooOld.add(NODE.A);
		const p = await put();
		expect(p.success).toBe(false);
		expect(p.content).toContain(SECURE_HANDOFF_MIN_CLI);
		expect(p.content).not.toMatch(/→ 404/);

		runnerTooOld.clear();
		const { handle } = JSON.parse((await put()).content) as { handle: string };
		runnerTooOld.add(NODE.B);
		const g = await run("B", "tmux_secure_get", { handle, path: "/x" });
		expect(g.success).toBe(false);
		expect(g.content).toContain(SECURE_HANDOFF_MIN_CLI);
		expect((await getSecureInputStatus(env, handle, "A", "owner"))?.status).toBe("ready");
	});

	it("reports a missing source file by path, and deposits nothing", async () => {
		const p = await run("A", "tmux_secure_put", { path: "/nope", label: "x" });
		expect(p.success).toBe(false);
		expect(p.content).toBe("No file at /nope.");
		expect(await listSecureInputRequests(env, "A", "owner")).toEqual([]);
	});

	it("sits behind the same tmux write-consent as the Operator's other writes", async () => {
		d1.exec("DELETE FROM instance_connector_consent WHERE instance_id = 'A'");
		const p = await put();
		expect(p.success).toBe(false);
		expect(p.content).toMatch(/isn't permitted/);
		expect(relayed).toEqual([]);
	});
});
