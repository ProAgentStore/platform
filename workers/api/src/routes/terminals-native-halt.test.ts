/**
 * #1057 slice 3 — the OWNER's halt and resume of a machine's native control, over the real routes and schema.
 * The agent can halt itself (`native_halt`); only these routes clear a halt, and they work whether or not the machine is opted in.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

const rt = vi.hoisted(() => ({ call: vi.fn(), owned: true }));
vi.mock("../lib/auth.js", async (orig) => ({
	...(await orig<typeof import("../lib/auth.js")>()),
	requireUser: async (c: { req: { header: (n: string) => string | undefined } }) => ({ uid: c.req.header("x-test-uid") ?? "u1", roles: [] }),
}));
vi.mock("./terminals.js", () => ({ machineDetail: async (_env: unknown, uid: string, id: string) => (rt.owned && uid === "u1" && id === "machine-abc123" ? { machineId: id, node: "mac-mini" } : null) }));
vi.mock("./instances-runtime.js", async (orig) => ({
	...(await orig<typeof import("./instances-runtime.js")>()),
	getLiveRuntime: async () => ({ instance_id: "i1", runner_node: "mac-mini", machine_id: "machine-abc123", capabilities: "[]" }),
	callRuntime: (...a: unknown[]) => rt.call(...a),
}));
const { terminalNativeRoutes } = await import("./terminals-native.js");
const { getNativeHalt, haltNative } = await import("../lib/native/halt.js");

const MACHINE = "machine-abc123";
let d1: RealSchemaD1;
let env: Env;
const app = new Hono<{ Bindings: Env }>().route("/", terminalNativeRoutes);
const req = (method: string, path: string, body?: unknown, uid = "u1") => app.request(`/machines/${MACHINE}/${path}`, { method, headers: { "x-test-uid": uid, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id, github_login) VALUES ('u1','u1'), ('u2','u2')");
	d1.exec("INSERT INTO agents (id, owner_id, slug, name) VALUES ('a1','u1','t','T')");
	d1.exec("INSERT INTO agent_instances (id, agent_id, user_id) VALUES ('i1','a1','u1')");
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, token_plaintext, machine_id, status) VALUES ('i1','u1','mac-mini','https://r.example/x','t','${MACHINE}','registered')`);
	env = { DB: d1.DB } as unknown as Env;
	rt.owned = true;
	rt.call.mockReset();
	rt.call.mockImplementation(async () => new Response("{}", { status: 200 }));
});
afterEach(() => d1.close());

describe("the owner halts and resumes a machine's native control", () => {
	it("reads as not halted, halts with a reason, tells the runner, and reads back who and why", async () => {
		expect(await (await req("GET", "native-halt")).json()).toEqual({ halted: false });
		const res = await req("POST", "native-halt", { reason: "Stepping away" });
		expect(await res.json()).toEqual({ halted: true, runnerTold: true });
		expect(rt.call).toHaveBeenCalledWith(expect.anything(), expect.anything(), "/native/halt", expect.anything());
		expect(await (await req("GET", "native-halt")).json()).toMatchObject({ halted: true, by: "owner", reason: "Stepping away" });
	});

	it("works while the runner is away: the cloud row holds and the answer says the runner was not told", async () => {
		rt.call.mockRejectedValue(new Error("relay down"));
		expect(await (await req("POST", "native-halt")).json()).toEqual({ halted: true, runnerTold: false });
		expect(await getNativeHalt(env, "u1", MACHINE)).not.toBeNull();
	});

	it("resume clears an agent's halt and tells the runner; resuming nothing is harmless", async () => {
		await haltNative(env, "u1", MACHINE, "agent", "stopped itself");
		rt.call.mockClear();
		expect(await (await req("POST", "native-resume")).json()).toEqual({ wasHalted: true, runnerTold: true });
		expect(rt.call).toHaveBeenCalledWith(expect.anything(), expect.anything(), "/native/resume", expect.anything());
		expect(await getNativeHalt(env, "u1", MACHINE)).toBeNull();
		expect(await (await req("POST", "native-resume")).json()).toMatchObject({ wasHalted: false });
	});

	it("a machine that is not the caller's is a 404 and nothing is written", async () => {
		rt.owned = false;
		for (const [m, p] of [["GET", "native-halt"], ["POST", "native-halt"], ["POST", "native-resume"]] as const) expect((await req(m, p)).status).toBe(404);
		expect(await getNativeHalt(env, "u1", MACHINE)).toBeNull();
		expect(rt.call).not.toHaveBeenCalled();
	});

	it("one owner's halt is not another's: halting as u1 leaves u2's same-named machine alone", async () => {
		await haltNative(env, "u1", MACHINE, "owner");
		expect(await getNativeHalt(env, "u2", MACHINE)).toBeNull();
	});
});
