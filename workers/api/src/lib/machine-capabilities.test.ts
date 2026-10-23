/**
 * #1312 — storage, change history and the fail-fast gate, on the real migrated schema. Also holds the CLI's hash and
 * the platform's hash to the same answer, which is what lets a heartbeat say "unchanged" without resending the record.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DetectDeps, capabilityHash as cliHash, detectMachineCapabilities, SKIP_PROBE_ENV } from "../../../../packages/cli/src/capabilities/detect.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { capabilityHistory, checkJobCapabilityRequirements, getMachineCapabilities, HISTORY_KEEP, listCapabilitySummaries, storedCapabilityHash, upsertMachineCapabilities } from "./machine-capabilities.js";
import { capabilityHash as apiHash, parseMachineCapabilities } from "./machine-capability-schema.js";
import type { Env } from "../types.js";

const M = "3901c9c4-004f-435e-bfc5-0b87b7ac5173";
const record = (over: Record<string, unknown> = {}) => ({
	detectedAt: "2026-10-23T00:00:00.000Z",
	os: { name: "macOS", version: "12.7.6", arch: "x64" },
	cpuCount: 4, memoryGb: 8, diskGb: 250, nodeVersion: "22.4.0",
	playwright: { version: "1.58.2", probes: [] },
	ios: false, android: false, docker: false,
	inventory: [{ name: "git", version: "2.45.2" }, { name: "wrangler", version: "4.9.0" }],
	...over,
});

let d1: RealSchemaD1;
let env: Env;
beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

describe("upsert and read-back", () => {
	it("stores a validated record, reads it back, and exposes the columns selection reads", async () => {
		expect(await upsertMachineCapabilities(env, "u1", M, record())).toMatchObject({ stored: true, changed: true, diff: ["first report"] });
		const got = await getMachineCapabilities(env, "u1", M);
		expect(got?.capabilities.os).toEqual({ name: "macOS", version: "12.7.6", arch: "x64" });
		expect(d1.sqlite.prepare("SELECT os_name, os_version, arch, playwright_version, docker_support, node_version FROM machine_capabilities").get()).toEqual({ os_name: "macOS", os_version: "12.7.6", arch: "x64", playwright_version: "1.58.2", docker_support: 0, node_version: "22.4.0" });
	});
	it("stores nothing for a machine with no id or a body that is not a record", async () => {
		expect(await upsertMachineCapabilities(env, "u1", "", record())).toEqual({ stored: false, reason: "no machine id" });
		expect(await upsertMachineCapabilities(env, "u1", M, { nonsense: true })).toEqual({ stored: false, reason: "not a capability record" });
		expect(await getMachineCapabilities(env, "u1", M)).toBeNull();
	});
	it("never stores what the schema strips, even when the runner sends it", async () => {
		await upsertMachineCapabilities(env, "u1", M, record({ username: "serge", env: { TOKEN: "sk-x" }, nodeVersion: "/opt/node" }));
		const raw = (d1.sqlite.prepare("SELECT raw_json FROM machine_capabilities").get() as { raw_json: string }).raw_json;
		expect(raw).not.toMatch(/serge|sk-x|TOKEN|\/opt/);
	});
	it("is scoped to the owner: another account cannot read or overwrite a machine's record", async () => {
		await upsertMachineCapabilities(env, "u1", M, record());
		expect(await getMachineCapabilities(env, "u2", M)).toBeNull();
		await upsertMachineCapabilities(env, "u2", M, record({ nodeVersion: "99.0.0" }));
		expect((await getMachineCapabilities(env, "u1", M))?.capabilities.nodeVersion).toBe("22.4.0");
	});
});

describe("changes are recorded (#1312)", () => {
	it("an unchanged re-report records nothing; a change records exactly what moved", async () => {
		await upsertMachineCapabilities(env, "u1", M, record());
		expect(await upsertMachineCapabilities(env, "u1", M, record({ detectedAt: "2026-10-24T00:00:00.000Z" }))).toMatchObject({ changed: false, diff: [] });
		const r = await upsertMachineCapabilities(env, "u1", M, record({
			os: { name: "macOS", version: "13.6", arch: "x64" },
			playwright: { version: "1.60.0", probes: [{ browser: "webkit", success: true, durationMs: 900 }] },
			inventory: [{ name: "git", version: "2.46.0" }],
		}));
		expect(r).toMatchObject({ changed: true });
		if (!r.stored) throw new Error("unreachable");
		expect(r.diff).toEqual(expect.arrayContaining(["os: macOS 12.7.6 → macOS 13.6", "playwright: 1.58.2 → 1.60.0", "webkit: unprobed → launches", "git: 2.45.2 → 2.46.0", "wrangler: removed"]));
		const history = await capabilityHistory(env, "u1", M);
		expect(history.map((h) => h.changes[0])).toEqual([r.diff[0], "first report"]);
	});
	it("a probe timing alone is not a change", async () => {
		const withProbe = (ms: number) => record({ playwright: { version: "1.58.2", probes: [{ browser: "firefox", success: true, durationMs: ms }] } });
		await upsertMachineCapabilities(env, "u1", M, withProbe(100));
		expect(await upsertMachineCapabilities(env, "u1", M, withProbe(4000))).toMatchObject({ changed: false });
	});
	it(`keeps only the latest ${HISTORY_KEEP} changes`, async () => {
		for (let i = 0; i < HISTORY_KEEP + 5; i++) await upsertMachineCapabilities(env, "u1", M, record({ nodeVersion: `22.${i}.0` }));
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM machine_capability_history").get() as { n: number }).n).toBe(HISTORY_KEEP);
	});
});

describe("the heartbeat can say 'unchanged' because both sides hash alike (#1312)", () => {
	it("the CLI's hash of a detected record equals the platform's hash of the same record after validation", async () => {
		const deps: DetectDeps = {
			platform: "darwin", arch: "x64", release: "21.6.0", cpuCount: 4, totalMemBytes: 8 * 2 ** 30, diskTotalBytes: () => 250 * 2 ** 30, nodeVersion: "22.4.0",
			env: { [SKIP_PROBE_ENV]: "1" }, now: () => new Date("2026-10-23T00:00:00Z"),
			run: async (file, args) => { if (`${file} ${args.join(" ")}` === "git --version") return "git version 2.45.2"; throw new Error("ENOENT"); },
			playwrightVersion: () => "1.58.2", launch: async () => undefined,
		};
		const detected = await detectMachineCapabilities(deps);
		const parsed = parseMachineCapabilities(detected);
		expect(parsed).not.toBeNull();
		expect(await apiHash(parsed!)).toBe(cliHash(detected));
		await upsertMachineCapabilities(env, "u1", M, detected);
		expect(await storedCapabilityHash(env, "u1", M)).toBe(cliHash(detected));
	});
	it("holds with probes, tools and a failure message in the record", async () => {
		const detected = (await detectMachineCapabilities({
			platform: "linux", arch: "arm64", release: "6.8.0", cpuCount: 2, totalMemBytes: 4 * 2 ** 30, diskTotalBytes: () => null, nodeVersion: "20.1.0", env: {}, now: () => new Date(),
			run: async (f) => { if (f === "gh") return "gh version 2.60.1"; throw new Error("x"); },
			playwrightVersion: () => "1.60.0", launch: async (b) => { if (b === "webkit") throw new Error("missing libs at /usr/lib/x"); },
		}));
		expect(await apiHash(parseMachineCapabilities(detected)!)).toBe(cliHash(detected));
	});
});

describe("the fail-fast gate (#1312)", () => {
	it("passes an empty requirement list without a record, and a satisfied one", async () => {
		expect(await checkJobCapabilityRequirements(env, "u1", M, [])).toEqual({ ok: true, failures: [] });
		await upsertMachineCapabilities(env, "u1", M, record({ os: { name: "macOS", version: "14.5", arch: "arm64" }, playwright: { version: "1.60.0", probes: [{ browser: "webkit", success: true, durationMs: 1 }] } }));
		expect(await checkJobCapabilityRequirements(env, "u1", M, ["webkit", "node>=22", "wrangler"])).toEqual({ ok: true, failures: [] });
	});
	it("the macOS 12 laptop is refused a webkit job, naming the machine and the reason", async () => {
		await upsertMachineCapabilities(env, "u1", M, record());
		const r = await checkJobCapabilityRequirements(env, "u1", M, ["webkit"]);
		expect(r.ok).toBe(false);
		expect(r.failures).toEqual([expect.stringMatching(/^machine 3901c9c4: needs webkit: webkit is not supported: macOS 12\.7\.6 is incompatible with Playwright 1\.58\.2/)]);
	});
	it("a machine that never reported, or has no id, cannot be verified and is refused", async () => {
		expect((await checkJobCapabilityRequirements(env, "u1", M, ["docker"])).ok).toBe(false);
		expect((await checkJobCapabilityRequirements(env, "u1", null, ["docker"])).failures[0]).toMatch(/has not reported/);
	});
	it("bounds the work a requirement list can cause", async () => {
		await upsertMachineCapabilities(env, "u1", M, record());
		const r = await checkJobCapabilityRequirements(env, "u1", M, Array.from({ length: 500 }, (_, i) => `tool${i}`));
		expect(r.failures.length).toBeLessThanOrEqual(20);
	});
});

describe("the summary read-back", () => {
	it("gives each engine a verdict and flags whether it was probed", async () => {
		await upsertMachineCapabilities(env, "u1", M, record({ ios: true }));
		const s = (await listCapabilitySummaries(env, "u1")).get(M);
		expect(s).toMatchObject({ os: "macOS 12.7.6", ios: true, playwrightVersion: "1.58.2", inventoryCount: 2 });
		expect(s?.browsers.webkit).toMatchObject({ supported: false, probed: false });
		expect(s?.browsers.chromium.reason).toMatch(/macOS 12\.7\.6 is incompatible/);
		expect((await listCapabilitySummaries(env, "u2")).size).toBe(0);
	});
});
