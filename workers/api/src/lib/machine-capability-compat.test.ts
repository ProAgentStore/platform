/**
 * #1312 — compatibility and selection. The incident: a WebKit smoke test landed on a macOS 12 laptop where Playwright
 * 1.58.2 cannot run WebKit or Chromium. These are synthetic machines; no browser is launched.
 */
import { describe, expect, it } from "vitest";
import { checkBrowserCompatibility, checkCapabilityRequirements, compareVersions, PLAYWRIGHT_OS_COMPAT } from "./machine-capability-compat.js";
import { type MachineCapabilities, parseMachineCapabilities } from "./machine-capability-schema.js";

const base = (over: Partial<MachineCapabilities> = {}): MachineCapabilities => ({
	schemaVersion: 1,
	detectedAt: "2026-10-23T00:00:00.000Z",
	os: { name: "macOS", version: "14.5", arch: "arm64" },
	cpuCount: 10,
	memoryGb: 32,
	diskGb: 500,
	nodeVersion: "22.4.0",
	playwright: { version: "1.60.0", probes: [] },
	ios: true,
	android: false,
	docker: true,
	inventory: [{ name: "wrangler", version: "4.9.0" }, { name: "gh", version: "2.60.1" }, { name: "pags", version: "0.4.177-rc.2" }],
	...over,
});
const MAC12 = base({ os: { name: "macOS", version: "12.7.6", arch: "x64" }, playwright: { version: "1.58.2", probes: [] }, ios: false, docker: false });

describe("macOS 12 rejects WebKit and Chromium (#1312)", () => {
	it("by the rule table, before any probe has run — naming the OS and the Playwright version", () => {
		for (const engine of ["webkit", "chromium"]) {
			const r = checkBrowserCompatibility(MAC12, engine);
			expect(r.supported).toBe(false);
			expect(r.reason).toMatch(new RegExp(`${engine} is not supported: macOS 12\\.7\\.6 is incompatible with Playwright 1\\.58\\.2`));
		}
	});
	it("a webkit-requiring job is rejected with a clear message naming what is missing", () => {
		const r = checkCapabilityRequirements(MAC12, ["webkit"]);
		expect(r.satisfied).toBe(false);
		expect(r.failures).toEqual([expect.stringMatching(/^needs webkit: webkit is not supported: macOS 12\.7\.6 is incompatible with Playwright 1\.58\.2/)]);
	});
	it("Firefox is not in the rule, so it is merely unconfirmed until probed", () => {
		expect(checkBrowserCompatibility(MAC12, "firefox")).toEqual({ supported: false, reason: expect.stringMatching(/not probed/) });
	});
	it("a successful probe overrides the prediction: the rule is a guess, the launch is a measurement", () => {
		const probed = { ...MAC12, playwright: { version: "1.58.2", probes: [{ browser: "webkit" as const, success: true, durationMs: 800 }] } };
		expect(checkBrowserCompatibility(probed, "webkit")).toEqual({ supported: true });
	});
	it("a failed probe says why, with the OS and Playwright version", () => {
		const m = base({ playwright: { version: "1.60.0", probes: [{ browser: "webkit", success: false, error: "dependencies missing", durationMs: 300 }] } });
		expect(checkBrowserCompatibility(m, "webkit").reason).toBe("webkit failed to launch on macOS 14.5 with Playwright 1.60.0: dependencies missing");
	});
	it("the rule is bounded: macOS 13 and a Playwright older than the observed break are not caught by it", () => {
		const rule = PLAYWRIGHT_OS_COMPAT[0];
		expect(rule).toMatchObject({ os: "darwin", osMaxMajor: 12 });
		expect(checkBrowserCompatibility({ ...MAC12, os: { ...MAC12.os, version: "13.6" } }, "webkit").reason).toMatch(/not probed/);
		expect(checkBrowserCompatibility({ ...MAC12, playwright: { version: "1.40.0", probes: [] } }, "webkit").reason).toMatch(/not probed/);
	});
	it("without Playwright installed no engine can be launched", () => {
		expect(checkBrowserCompatibility(base({ playwright: { version: null, probes: [] } }), "chromium").reason).toMatch(/Playwright is not installed/);
	});
	it("an engine the platform does not track is refused by name", () => {
		expect(checkBrowserCompatibility(base(), "netscape")).toEqual({ supported: false, reason: expect.stringMatching(/not a browser engine/) });
	});
});

describe("requirement checking (#1312)", () => {
	const modern = base({ playwright: { version: "1.60.0", probes: [{ browser: "webkit", success: true, durationMs: 1 }, { browser: "chromium", success: true, durationMs: 1 }] } });
	it("satisfies the issue's example: node>=22, playwright webkit, wrangler", () => {
		expect(checkCapabilityRequirements(modern, ["node>=22", "webkit", "wrangler"])).toEqual({ satisfied: true, failures: [] });
	});
	it("names every failure, not just the first", () => {
		const r = checkCapabilityRequirements(MAC12, ["webkit", "node>=24", "wrangler", "docker", "ios", "android", "terraform"]);
		expect(r.satisfied).toBe(false);
		expect(r.failures).toHaveLength(6); // wrangler is installed, so it is the one that passes
		expect(r.failures).toEqual(expect.arrayContaining(["needs node>=24: this machine has node 22.4.0", "needs docker: it is not available on macOS 12.7.6", "needs terraform: terraform is not in this machine's inventory"]));
	});
	it("compares versions numerically, release candidates included", () => {
		expect(compareVersions("22.10.0", "22.9.1")).toBeGreaterThan(0);
		expect(compareVersions("0.4.177-rc.2", "0.4.177")).toBe(0);
		expect(checkCapabilityRequirements(modern, ["pags>=0.4", "gh>2.60.1"]).failures).toEqual(["needs gh>2.60.1: this machine has gh 2.60.1"]);
	});
	it("a machine that has never reported fails every requirement — it cannot be verified", () => {
		const r = checkCapabilityRequirements(null, ["webkit"]);
		expect(r.satisfied).toBe(false);
		expect(r.failures[0]).toMatch(/has not reported its capabilities/);
	});
	it("an empty list is satisfied by anything, even an unreported machine; a malformed one is named", () => {
		expect(checkCapabilityRequirements(null, [])).toEqual({ satisfied: true, failures: [] });
		expect(checkCapabilityRequirements(modern, ["node>>22"]).failures[0]).toMatch(/not a requirement the platform understands/);
	});
});

describe("the schema keeps the record bounded and private (#1312)", () => {
	it("clips strings, caps lists, drops path-shaped and secret-shaped values, and ignores unknown fields", () => {
		const parsed = parseMachineCapabilities({
			os: { name: "macOS", version: "x".repeat(500), arch: "arm64" },
			cpuCount: 99999,
			memoryGb: -5,
			nodeVersion: "/usr/local/bin/node",
			username: "serge",
			env: { TOKEN: "sk-secret" },
			playwright: { version: "1.60.0", probes: [{ browser: "webkit", success: false, error: `no exec at /Users/serge/.cache/ms-playwright/x ${"y".repeat(500)}`, durationMs: 5 }, { browser: "netscape", success: true }, { browser: "webkit", success: true }] },
			inventory: Array.from({ length: 80 }, (_, i) => ({ name: `tool${i}`, version: "1.0.0" })).concat([{ name: "../../etc/passwd", version: "1" }, { name: "ok", version: "C:\\Users\\bob" }]),
		});
		expect(parsed).not.toBeNull();
		if (!parsed) return;
		expect(parsed.os.version.length).toBeLessThanOrEqual(64);
		expect(parsed.cpuCount).toBeNull();
		expect(parsed.memoryGb).toBeNull();
		expect(parsed.nodeVersion).toBeNull();
		expect(parsed.playwright.probes).toHaveLength(1);
		expect(parsed.playwright.probes[0].error?.startsWith("no exec at <path> ")).toBe(true);
		expect(parsed.playwright.probes[0].error?.length).toBeLessThanOrEqual(200);
		expect(parsed.inventory).toHaveLength(40);
		expect(parsed.inventory.some((i) => i.name.includes("/") || i.name === "ok")).toBe(false);
		expect(JSON.stringify(parsed)).not.toMatch(/serge|sk-secret|TOKEN|username|\/Users/);
	});
	it("rejects what is not a capability record", () => {
		for (const bad of [null, "x", 5, [], {}, { os: {} }, { os: { name: "", arch: "" } }]) expect(parseMachineCapabilities(bad)).toBeNull();
	});
});
