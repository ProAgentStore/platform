/**
 * #1057 slice 1 — the `local_native` foundation on the real schema.
 *
 * Invariants:
 *  - the wire contract is one file, vendored byte-for-byte into the runner, importing nothing;
 *  - native control is OFF per machine by default, and turning it ON needs the CURRENT account-risk
 *    disclosure acknowledged — missing or stale versions are refused and nothing is saved;
 *  - turning it OFF never needs an acknowledgement, and an opt-in under an old disclosure stops counting;
 *  - the preflight is refused with NATIVE_NOT_ENABLED before any runner is contacted, and names
 *    every other reason (no runner, too old, unreachable) with a stable code;
 *  - the opt-in survives on the existing machine policy row without touching auto-update.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "../d1-sqlite.js";
import type { Env } from "../../types.js";

const rt = vi.hoisted(() => ({ live: null as Record<string, unknown> | null, call: vi.fn() }));
vi.mock("../../routes/instances-runtime.js", async (orig) => ({
	...(await orig<typeof import("../../routes/instances-runtime.js")>()),
	getLiveRuntime: async () => rt.live,
	callRuntime: (...a: unknown[]) => rt.call(...a),
}));

const { getNativeOptIn, NATIVE_RISK_DISCLOSURE_V1, nativeAnyEnabled, setNativeOptIn } = await import("./policy.js");
const { nativePreflight } = await import("./preflight.js");
const { KNOWN_RUNTIMES, sanitizeDeclaredCapabilities } = await import("../agent-capabilities.js");

const ROOT = join(__dirname, "../../../../..");
const V = NATIVE_RISK_DISCLOSURE_V1.version;
const MACHINE = "machine-abc123";
let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id, github_login) VALUES ('u1','u1'); INSERT INTO agents (id, owner_id, slug, name) VALUES ('a1','u1','a1','A'); INSERT INTO agent_instances (id, agent_id, user_id) VALUES ('i1','a1','u1');");
	env = { DB: d1.DB } as unknown as Env;
	rt.live = { instance_id: "i1", runner_node: "mac-mini", machine_id: MACHINE, capabilities: JSON.stringify(["browser.playwright", "native.preflight"]), runner_version: "0.4.126" };
	rt.call.mockReset();
});
afterEach(() => d1.close());

describe("the contract", () => {
	it("is byte-identical in the Worker and the runner, and imports nothing", () => {
		const worker = readFileSync(join(ROOT, "workers/api/src/lib/native/contract.ts"), "utf8");
		expect(readFileSync(join(ROOT, "packages/browser-runner/src/native/contract.ts"), "utf8")).toBe(worker);
		expect(worker).not.toMatch(/^import /m);
	});

	it("`local_native` is a known runtime a creator can declare", () => {
		expect(KNOWN_RUNTIMES.has("local_native")).toBe(true);
		expect(sanitizeDeclaredCapabilities({ runtime: "local_native" })).toMatchObject({ runtime: "local_native" });
	});
});

describe("per-machine opt-in", () => {
	it("is OFF by default", async () => {
		const o = (await getNativeOptIn(env, "u1", MACHINE))!;
		expect(o).toMatchObject({ desktop: false, maestro: false, disclosureVersion: null, disclosureCurrent: false });
		expect(nativeAnyEnabled(o)).toBe(false);
	});

	it("enabling without the disclosure, or with an outdated one, is refused and saves nothing", async () => {
		expect(await setNativeOptIn(env, "u1", MACHINE, { desktop: true })).toMatchObject({ ok: false, code: "NATIVE_DISCLOSURE_REQUIRED" });
		expect(await setNativeOptIn(env, "u1", MACHINE, { maestro: true, acknowledgedDisclosureVersion: "2025-01-01.v0" })).toMatchObject({ ok: false, code: "NATIVE_DISCLOSURE_OUTDATED" });
		expect(d1.sqlite.prepare("SELECT count(*) AS n FROM machine_policies").get()).toEqual({ n: 0 });
	});

	it("enabling with the current disclosure saves the switch, the version and the time — and leaves auto-update OFF", async () => {
		const out = await setNativeOptIn(env, "u1", MACHINE, { desktop: true, acknowledgedDisclosureVersion: V });
		expect(out).toMatchObject({ ok: true, optIn: { desktop: true, maestro: false, disclosureVersion: V, disclosureCurrent: true } });
		expect(d1.sqlite.prepare("SELECT auto_update FROM machine_policies WHERE machine_id = ?").get(MACHINE)).toEqual({ auto_update: 0 });
	});

	it("disabling needs no acknowledgement, and an opt-in under an old disclosure no longer counts", async () => {
		await setNativeOptIn(env, "u1", MACHINE, { desktop: true, maestro: true, acknowledgedDisclosureVersion: V });
		expect(await setNativeOptIn(env, "u1", MACHINE, { maestro: false })).toMatchObject({ ok: true, optIn: { desktop: true, maestro: false } });
		d1.exec(`UPDATE machine_policies SET native_risk_disclosure_version = '2025-01-01.v0'`);
		const stale = (await getNativeOptIn(env, "u1", MACHINE))!;
		expect(stale).toMatchObject({ desktop: true, disclosureCurrent: false });
		expect(nativeAnyEnabled(stale)).toBe(false);
	});

	it("is per owner: another account's opt-in for the same machine id grants nothing", async () => {
		d1.exec("INSERT INTO users (id, github_login) VALUES ('u2','u2')");
		await setNativeOptIn(env, "u2", MACHINE, { desktop: true, acknowledgedDisclosureVersion: V });
		expect(nativeAnyEnabled((await getNativeOptIn(env, "u1", MACHINE))!)).toBe(false);
	});

	it("the disclosure names WeChat's ban risk and recommends a secondary or read-only account", () => {
		expect(NATIVE_RISK_DISCLOSURE_V1.text).toMatch(/WeChat/);
		expect(NATIVE_RISK_DISCLOSURE_V1.text).toMatch(/bans accounts/);
		expect(NATIVE_RISK_DISCLOSURE_V1.text).toMatch(/secondary account, or read-only use/);
	});
});

describe("native preflight gate", () => {
	const PROBE = { os: "darwin", osVersion: "15.7.1", arch: "arm64", desktop: { screenRecording: "denied", accessibility: "granted", permissionState: "denied" }, maestro: { installed: false, version: null, adbInstalled: false, simctlAvailable: true, connectedDevices: [] }, errors: [{ code: "NATIVE_PERMISSIONS_MISSING", message: "…" }], checkedAt: 1 };

	it("machine not opted in: 403 NATIVE_NOT_ENABLED, and the runner is never contacted", async () => {
		const out = await nativePreflight(env, "i1", "u1");
		expect(out).toMatchObject({ status: 403, body: { code: "NATIVE_NOT_ENABLED", machineId: MACHINE, disclosureVersion: V } });
		expect(rt.call).not.toHaveBeenCalled();
	});

	it("opted in: asks the runner's read-only probe and returns it with the enabled backends", async () => {
		await setNativeOptIn(env, "u1", MACHINE, { desktop: true, acknowledgedDisclosureVersion: V });
		rt.call.mockResolvedValue(new Response(JSON.stringify(PROBE), { status: 200 }));
		const out = await nativePreflight(env, "i1", "u1");
		expect(out).toEqual({ status: 200, body: { machineId: MACHINE, node: "mac-mini", enabled: { desktop: true, maestro: false }, preflight: PROBE } });
		expect(rt.call).toHaveBeenCalledWith(env, rt.live, "/native/preflight", { method: "POST", body: "{}" });
		const audit = d1.sqlite.prepare("SELECT event, context FROM agent_events WHERE event = 'native.preflight'").get() as { event: string; context: string };
		expect(JSON.parse(audit.context)).toMatchObject({ machineId: MACHINE, desktopPermission: "denied", errors: ["NATIVE_PERMISSIONS_MISSING"] });
	});

	it.each([
		["no live runner", () => { rt.live = null; }, 409, "NATIVE_RUNNER_UNREACHABLE"],
		["a runner with no machine id", () => { rt.live = { ...rt.live, machine_id: null }; }, 409, "NATIVE_RUNNER_UNSUPPORTED"],
		["a runner too old to answer", () => { rt.live = { ...rt.live, capabilities: JSON.stringify(["browser.playwright"]) }; }, 409, "NATIVE_RUNNER_UNSUPPORTED"],
		["a runner that dropped", () => { rt.call.mockRejectedValue(new Error("relay closed")); }, 503, "NATIVE_RUNNER_UNREACHABLE"],
		["a runner that does not know the route", () => { rt.call.mockResolvedValue(new Response("{}", { status: 404 })); }, 409, "NATIVE_RUNNER_UNSUPPORTED"],
	])("%s → a stable code, never a silent wait", async (_why, arrange, status, code) => {
		await setNativeOptIn(env, "u1", MACHINE, { maestro: true, acknowledgedDisclosureVersion: V });
		arrange();
		expect(await nativePreflight(env, "i1", "u1")).toMatchObject({ status, body: { code } });
	});
});
