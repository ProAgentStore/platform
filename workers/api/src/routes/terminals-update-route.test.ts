/**
 * The update ROUTE pair (#990): the POST answers at once with an operation, and the GET is where its
 * outcome lives.
 *
 * This is the seam the live failure happened at. `POST …/nodes/:node/update` used to await the whole
 * update — ~205s of it — behind a client whose confirmation deadline is 20s. The MCP seam aborted on
 * expiry, which cancelled the Worker, and the work died mid-flight having written nothing: two
 * attempts on `Macmini.modem` returned `outcome: "unknown"` and the node stayed on 0.4.84 with no
 * outcome and no error anywhere. So what is asserted here is the CONTRACT that makes that
 * impossible — the reply arrives without waiting for the machine, and the outcome is readable
 * afterwards whether or not anybody received that reply.
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

/** The machine's own answer, and how long it takes to give it. */
let reply: () => unknown = () => ({ action: "restarting", current: "0.4.84", latest: "0.4.85", restartedBy: "pags-up" });
let replyDelayMs = 0;

vi.mock("../lib/runner-client.js", () => ({
	// The agent reconnects as soon as the runner is back, so the re-attach wait ends on its first
	// poll: this file is about the ROUTE contract, and the timing of that wait is covered with a
	// fast clock in `runner-update-ops.test.ts` (the route deliberately has no clock seam).
	relayConnected: async (_e: unknown, id: string, node: string) => `${id}@${node}` === "i1@Macmini.modem",
	evictStaleRunnerSocket: async () => ({ sockets: 0, alive: false, evicted: 0 }),
	getRunnerConnIgnoringLiveness: async (_e: unknown, id: string, _uid: string, node: string) => ({ instanceId: id, runnerNode: node }),
	callRunner: async (_conn: unknown, path: string) => {
		if (path !== "/pags/runner/update") return { attached: [] };
		if (replyDelayMs) await new Promise((r) => setTimeout(r, replyDelayMs));
		const r = reply();
		if (r instanceof Error) throw r;
		return r;
	},
}));

const { terminalRoutes } = await import("./terminals.js");

let d1: RealSchemaD1;
/** Promises handed to `waitUntil`, exactly as the platform would run them after the response. */
let pending: Promise<unknown>[];
const env = () => ({ DB: d1.DB }) as unknown as Env;

function app() {
	const a = new Hono<{ Bindings: Env }>();
	a.route("/v1/terminals", terminalRoutes);
	a.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	return a;
}
async function call(method: string, path: string, body?: unknown) {
	const res = await app().request(
		`/v1/terminals${path}`,
		{ method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
		env(),
		// The real execution context: a backgrounded promise is NOT awaited before the response.
		{ waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} } as never,
	);
	// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const settle = async () => {
	await Promise.all(pending);
	pending = [];
};

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('a1', 'u1', 't990-route-coder', 'Repo Coder', '{"capabilities":{"surfaces":["coding"],"runtime":"coding"}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'a1', 'u1', 'active', '{}')`);
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, status, last_seen_at, updated_at)
	         VALUES ('i1', 'u1', 'Macmini.modem', 'relay://', '0.4.84', 'online', '2026-10-09 01:00:00', '2026-10-09 01:00:00')`);
	pending = [];
	replyDelayMs = 0;
	reply = () => ({ action: "restarting", current: "0.4.84", latest: "0.4.85", restartedBy: "pags-up" });
});
afterEach(() => d1.close());

const UPDATE = "/nodes/Macmini.modem/update";

describe("POST …/nodes/:node/update — a claim, not a wait (#990)", () => {
	it("answers before the machine does, with the operation to poll", async () => {
		// The machine takes longer to answer than the whole response cycle.
		replyDelayMs = 50;
		const started = Date.now();
		const res = await call("POST", UPDATE, {});
		expect(res.status).toBe(200);
		// The reply did not wait for the machine — this is what the 20s deadline needed.
		expect(Date.now() - started).toBeLessThan(50);
		expect(res.body).toMatchObject({ node: "Macmini.modem", state: "running", started: true });
		expect(res.body.operationId).toBeTruthy();
		expect(res.body.poll).toBe("/v1/terminals/nodes/Macmini.modem/update");
		// The work is on the execution context, so the platform runs it after the response.
		expect(pending).toHaveLength(1);
		await settle();
		const after = await call("GET", UPDATE);
		expect(after.body.state).toBe("restarted");
		expect(after.body.operation).toMatchObject({ id: res.body.operationId, currentVersion: "0.4.84", latestVersion: "0.4.85", restartedBy: "pags-up" });
	});

	it("THE LIVE FAILURE, as the contract now handles it: nobody receives the reply, the outcome is still recorded", async () => {
		const res = await call("POST", UPDATE, {});
		const operationId = res.body.operationId as string;
		// The caller is gone — its reply was lost, exactly as `deadline-exceeded` means. The work
		// continues, because it does not belong to the request any more.
		await settle();
		const polled = await call("GET", UPDATE);
		expect(polled.body.operation).toMatchObject({ id: operationId, state: "restarted" });
		expect(polled.body.operation.endedAt).toBeTruthy();
		expect(polled.body.operation.detail).toMatch(/updated 0\.4\.84 → 0\.4\.85/);
	});

	it("a retry while one is in flight joins it instead of installing twice", async () => {
		let calls = 0;
		reply = () => {
			calls++;
			return { action: "restarting", current: "0.4.84", latest: "0.4.85" };
		};
		const first = await call("POST", UPDATE, {});
		const second = await call("POST", UPDATE, {});
		expect(second.body).toMatchObject({ operationId: first.body.operationId, started: false });
		await settle();
		expect(calls, "one install, however many times the owner asks").toBe(1);
	});

	it("propagates a machine-side refusal as a terminal, readable state", async () => {
		reply = () => ({ action: "refused", current: "0.4.84", reason: "nothing here would restart the runner" });
		await call("POST", UPDATE, {});
		await settle();
		const polled = await call("GET", UPDATE);
		expect(polled.body.operation).toMatchObject({ state: "refused" });
		expect(polled.body.operation.detail).toMatch(/nothing here would restart the runner/);
	});

	it("a thrown relay error is the recorded outcome, not a lost request", async () => {
		reply = () => {
			throw new Error("relay exploded");
		};
		await call("POST", UPDATE, {});
		await settle();
		const polled = await call("GET", UPDATE);
		expect(polled.body.operation).toMatchObject({ state: "failed" });
		expect(polled.body.operation.detail).toMatch(/relay exploded/);
	});

	it("a dry run still answers inline: nothing is installed, so nothing needs to outlive the request", async () => {
		reply = () => ({ action: "wait", current: "0.4.84", latest: "0.4.85", waitingFor: ["session-1"] });
		const res = await call("POST", UPDATE, { dryRun: true });
		expect(res.body).toMatchObject({ action: "would-update", waitingFor: ["session-1"] });
		expect(res.body.operationId, "a dry run claims no operation").toBeUndefined();
		expect(pending, "and backgrounds nothing").toHaveLength(0);
		expect((await call("GET", UPDATE)).body.operation).toBeNull();
	});

	it("GET says so plainly when no update was ever asked for", async () => {
		const res = await call("GET", "/nodes/other-machine/update");
		expect(res.body).toMatchObject({ node: "other-machine", operation: null, state: null });
		expect(res.body.detail).toMatch(/No update has been asked for/);
	});

	it("the machine's row carries its latest update, so the fleet view needs no extra call", async () => {
		await call("POST", UPDATE, {});
		await settle();
		const list = await call("GET", "/nodes");
		const node = (list.body.nodes as Array<{ node: string; update?: { state: string } }>).find((n) => n.node === "Macmini.modem");
		expect(node?.update).toMatchObject({ state: "restarted" });
	});
});
