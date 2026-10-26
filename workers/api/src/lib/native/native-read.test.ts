/**
 * #1057 slice 2 — the native READ tools, through the real registry dispatcher on the real schema.
 *
 * Invariants:
 *  - native control is a grantable CAPABILITY: the four tools are registry tools any local_native agent
 *    can declare, read-scoped and non-mutating, with untrusted output;
 *  - a call is refused before the runner is contacted unless the agent's runtime is local_native, the
 *    input is well-formed, and the owner opted this machine in for THAT tool's backend;
 *  - a call that runs is a native_runs row with its events — metadata, never what the screen showed;
 *  - the runner's own refusals (permissions, no device, timeout) come back as their stable code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "../d1-sqlite.js";
import type { Env } from "../../types.js";

const rt = vi.hoisted(() => ({ live: null as Record<string, unknown> | null, call: vi.fn() }));
vi.mock("../../routes/instances-runtime.js", async (orig) => ({
	...(await orig<typeof import("../../routes/instances-runtime.js")>()),
	getLiveRuntime: async () => rt.live,
	callRuntime: (...a: unknown[]) => rt.call(...a),
}));

const { NATIVE_RISK_DISCLOSURE_V1, setNativeOptIn } = await import("./policy.js");
const { READ_ONLY_NATIVE_TOOLS } = await import("./contract.js");
const { getRegistryTool, runRegistryTool } = await import("../tool-registry.js");
const { CONNECTORS } = await import("../connectors/registry.js");

const V = NATIVE_RISK_DISCLOSURE_V1.version;
const MACHINE = "machine-abc123";
const TREE = { of: "WeChat", nodes: 3, truncated: false, root: { role: "application", name: "WeChat", children: [{ role: "AXWindow", name: "WeChat", children: [{ role: "AXStaticText", value: "Dinner at 7?" }] }] } };
let d1: RealSchemaD1;
let env: Env;
const ctx = () => ({ env, instanceId: "i1", userId: "u1" });
const answer = (body: unknown, status = 200) => rt.call.mockResolvedValue(new Response(JSON.stringify(body), { status }));
const runs = () => d1.sqlite.prepare("SELECT backend, status, error_code, machine_id, config FROM native_runs").all() as Array<Record<string, string | null>>;
const events = () => d1.sqlite.prepare("SELECT seq, type, detail FROM native_run_events ORDER BY seq").all() as Array<{ seq: number; type: string; detail: string }>;

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(
		`INSERT INTO users (id, github_login) VALUES ('u1','u1');
		 INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('a1','u1','native-agent','Native', '{"capabilities":{"surfaces":[],"runtime":"local_native","tools":["native_list_apps","native_accessibility_tree","native_maestro_devices","native_maestro_hierarchy"]}}');
		 INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('a2','u1','web-agent','Web', '{"capabilities":{"surfaces":[],"runtime":"browser"}}');
		 INSERT INTO agent_instances (id, agent_id, user_id) VALUES ('i1','a1','u1');
		 INSERT INTO agent_instances (id, agent_id, user_id) VALUES ('i2','a2','u1');`,
	);
	env = { DB: d1.DB } as unknown as Env;
	rt.live = { instance_id: "i1", runner_node: "mac-mini", machine_id: MACHINE, capabilities: JSON.stringify(["native.preflight", "native.read"]), runner_version: "0.4.163" };
	rt.call.mockReset();
});
afterEach(() => d1.close());

describe("a grantable capability, not one agent's feature", () => {
	it("the four reads are registry tools of the `native` connector: read-scoped, non-mutating, untrusted output, no write scope", () => {
		expect(READ_ONLY_NATIVE_TOOLS).toEqual(["native_list_apps", "native_accessibility_tree", "native_maestro_devices", "native_maestro_hierarchy"]);
		for (const name of READ_ONLY_NATIVE_TOOLS) expect(getRegistryTool(name)).toMatchObject({ connector: "native", scope: "read", mutates: false, untrustedOutput: true });
		expect(CONNECTORS.find((c) => c.id === "native")).toMatchObject({ auth: "none", scopes: { read: true, write: true } });
	});
});

describe("refused before the runner is asked", () => {
	it("an agent whose runtime is not local_native", async () => {
		await setNativeOptIn(env, "u1", MACHINE, { desktop: true, acknowledgedDisclosureVersion: V });
		const r = await runRegistryTool("native_list_apps", { env, instanceId: "i2", userId: "u1" }, {});
		expect(r).toMatchObject({ success: false, content: expect.stringMatching(/^NATIVE_NOT_ENABLED: .*runtime is local_native.*runtime is browser/) });
		expect(rt.call).not.toHaveBeenCalled();
	});

	it("a machine not opted in — and an opt-in for the OTHER backend does not count", async () => {
		expect(await runRegistryTool("native_accessibility_tree", ctx(), {})).toMatchObject({ success: false, content: expect.stringMatching(/^NATIVE_NOT_ENABLED: Native desktop control is off for mac-mini/) });
		await setNativeOptIn(env, "u1", MACHINE, { maestro: true, acknowledgedDisclosureVersion: V });
		expect(await runRegistryTool("native_accessibility_tree", ctx(), {})).toMatchObject({ success: false, content: expect.stringMatching(/^NATIVE_NOT_ENABLED/) });
		expect(rt.call).not.toHaveBeenCalled();
		expect(runs()).toEqual([]);
	});

	it("a malformed input, and a runner too old to serve the reads", async () => {
		await setNativeOptIn(env, "u1", MACHINE, { desktop: true, maestro: true, acknowledgedDisclosureVersion: V });
		expect(await runRegistryTool("native_maestro_hierarchy", ctx(), { deviceId: "x; rm -rf /" })).toMatchObject({ success: false, content: expect.stringMatching(/^NATIVE_INVALID_REQUEST/) });
		rt.live = { ...rt.live, capabilities: JSON.stringify(["native.preflight"]) };
		expect(await runRegistryTool("native_list_apps", ctx(), {})).toMatchObject({ success: false, content: expect.stringMatching(/^NATIVE_RUNNER_UNSUPPORTED: .*CLI 0\.4\.163.* cannot run the native read tools/) });
		expect(rt.call).not.toHaveBeenCalled();
	});
});

describe("a read that runs", () => {
	beforeEach(async () => {
		await setNativeOptIn(env, "u1", MACHINE, { desktop: true, maestro: true, acknowledgedDisclosureVersion: V });
	});

	it("forwards to the runner's read route, renders the tree for the model, fences it, and audits metadata only", async () => {
		answer({ ok: true, data: TREE });
		const r = await runRegistryTool("native_accessibility_tree", ctx(), { app: "WeChat", maxDepth: 3 });
		expect(rt.call).toHaveBeenCalledWith(env, rt.live, "/native/accessibility-tree", { method: "POST", body: JSON.stringify({ app: "WeChat", maxDepth: 3 }) });
		expect(r.success).toBe(true);
		expect(r.content).toContain('UI of WeChat — 3 element(s):');
		expect(r.content).toContain('    AXStaticText = "Dinner at 7?"');
		expect(r.content).toMatch(/untrusted/i); // screen text is fenced as data (ADR 0006)
		expect(runs()).toEqual([expect.objectContaining({ backend: "desktop", status: "completed", error_code: null, machine_id: MACHINE })]);
		expect(JSON.parse(runs()[0].config as string)).toEqual({ backend: "desktop", targetApp: "WeChat", readOnly: true, tool: "native_accessibility_tree" });
		expect(events().map((e) => e.type)).toEqual(["run.requested", "screen.read"]);
		expect(JSON.parse(events()[1].detail)).toEqual({ tool: "native_accessibility_tree", machineId: MACHINE, node: "mac-mini", nodes: 3, truncated: false });
		// What the screen showed is never stored.
		expect(JSON.stringify(events())).not.toContain("Dinner");
	});

	it("lists apps and devices in the model's words", async () => {
		answer({ ok: true, data: { apps: [{ name: "WeChat", pid: 812, bundleId: "com.tencent.xinWeChat", frontmost: true }] } });
		expect((await runRegistryTool("native_list_apps", ctx(), {})).content).toContain("- WeChat (pid 812, com.tencent.xinWeChat) ← in front");
		answer({ ok: true, data: { maestroInstalled: true, devices: [{ id: "emulator-5554", kind: "android", name: "Pixel 8", state: "device" }, { id: "R5CT", kind: "android", name: "R5CT", state: "unauthorized" }] } });
		const devices = await runRegistryTool("native_maestro_devices", ctx(), {});
		expect(devices.content).toContain("2 device(s), 1 ready for Maestro:");
		expect(devices.content).toContain("- R5CT — R5CT (Android, unauthorized) — not ready");
		expect(runs().map((r) => r.backend)).toEqual(["desktop", "maestro"]);
	});

	it.each([
		["the runner refused a permission", { ok: false, code: "NATIVE_PERMISSIONS_MISSING", message: "This machine has not granted Accessibility." }, "NATIVE_PERMISSIONS_MISSING"],
		["no such device", { ok: false, code: "NATIVE_DEVICE_NOT_FOUND", message: "No connected device has the id x." }, "NATIVE_DEVICE_NOT_FOUND"],
		["the machine timed out", { ok: false, code: "NATIVE_TIMEOUT", message: "Reading did not answer within its time limit." }, "NATIVE_TIMEOUT"],
	])("%s → its code, a failed run, never a silent wait", async (_why, reply, code) => {
		answer(reply);
		expect(await runRegistryTool("native_maestro_hierarchy", ctx(), { deviceId: "emulator-5554" })).toMatchObject({ success: false, content: expect.stringContaining(`${code}: `) });
		expect(runs()).toEqual([expect.objectContaining({ status: "failed", error_code: code })]);
		expect(events().map((e) => e.type)).toEqual(["run.requested", "run.failed"]);
	});

	it("a runner that dropped, or that does not know the route, is its own code", async () => {
		rt.call.mockRejectedValue(new Error("relay closed"));
		expect((await runRegistryTool("native_list_apps", ctx(), {})).content).toMatch(/^NATIVE_RUNNER_UNREACHABLE/);
		answer({}, 404);
		expect((await runRegistryTool("native_list_apps", ctx(), {})).content).toMatch(/^NATIVE_RUNNER_UNSUPPORTED/);
	});
});
