/**
 * #1312 — detection, on synthetic machines. Nothing here launches a browser or a child process: every probe, every
 * command and every `os` reading comes from a fixture, so the same test runs the same on any host.
 */
import { describe, expect, it, vi } from "vitest";
import { CapabilityReporter, type DetectDeps, INVENTORY_CAP, INVENTORY_TOOLS, capabilityHash, detectMachineCapabilities, detectOs, probeBrowsers, scrub, SKIP_PROBE_ENV, versionToken } from "./detect.js";

const NOW = new Date("2026-10-23T00:00:00Z");
function deps(over: Partial<DetectDeps> & { commands?: Record<string, string> } = {}): DetectDeps {
	const commands = over.commands ?? {};
	return {
		platform: "darwin",
		arch: "x64",
		release: "21.6.0",
		cpuCount: 4,
		totalMemBytes: 8 * 2 ** 30,
		diskTotalBytes: () => 250 * 2 ** 30,
		nodeVersion: "22.4.0",
		env: {},
		now: () => NOW,
		run: async (file, args) => {
			const key = [file, ...args].join(" ");
			if (key in commands) return commands[key];
			throw new Error(`spawn ${file} ENOENT`);
		},
		playwrightVersion: () => "1.58.2",
		launch: async () => undefined,
		...over,
	};
}

describe("OS detection", () => {
	it("reads the macOS marketing version from sw_vers, and falls back to the kernel map when it is absent", async () => {
		expect(await detectOs(deps({ commands: { "sw_vers -productVersion": "12.7.6\n" } }))).toEqual({ name: "macOS", version: "12.7.6", arch: "x64" });
		expect(await detectOs(deps())).toEqual({ name: "macOS", version: "12", arch: "x64" }); // kernel 21 → macOS 12
		expect(await detectOs(deps({ release: "23.5.0" }))).toMatchObject({ version: "14" });
	});
	it("names Windows and Linux without a path or a host name", async () => {
		expect(await detectOs(deps({ platform: "linux", release: "6.8.0-45-generic", arch: "arm64" }))).toEqual({ name: "Linux", version: "6.8.0-45-generic", arch: "arm64" });
		expect(await detectOs(deps({ platform: "win32", release: "10.0.22631" }))).toMatchObject({ name: "Windows", version: "10.0.22631" });
	});
});

describe("browser launch probes", () => {
	it("records, per engine, whether it actually launched and why not — with any path removed", async () => {
		const launch = vi.fn(async (b: string) => {
			if (b === "webkit") throw new Error("browserType.launch: Executable doesn't exist at /Users/serge/Library/Caches/ms-playwright/webkit-2123/pw_run.sh");
			if (b === "chromium") throw new Error("Chromium does not support macOS 12");
		});
		const probes = await probeBrowsers(deps({ launch }));
		expect(probes.map((p) => [p.browser, p.success])).toEqual([["chromium", false], ["firefox", true], ["webkit", false]]);
		expect(probes[2].error).toBe("browserType.launch: Executable doesn't exist at <path>");
		expect(JSON.stringify(probes)).not.toContain("serge");
		expect(probes[0].error).toBe("Chromium does not support macOS 12");
	});
	it(`is skipped entirely with ${SKIP_PROBE_ENV}=1 — nothing is launched`, async () => {
		const launch = vi.fn(async () => undefined);
		expect(await probeBrowsers(deps({ env: { [SKIP_PROBE_ENV]: "1" }, launch }))).toEqual([]);
		expect(launch).not.toHaveBeenCalled();
	});
	it("is skipped when Playwright is not installed", async () => {
		const launch = vi.fn(async () => undefined);
		expect(await probeBrowsers(deps({ playwrightVersion: () => null, launch }))).toEqual([]);
		expect(launch).not.toHaveBeenCalled();
	});
	it("gives each engine ten seconds, then records the timeout instead of hanging", async () => {
		vi.useFakeTimers();
		try {
			const pending = probeBrowsers(deps({ launch: () => new Promise(() => undefined) }));
			await vi.advanceTimersByTimeAsync(31_000);
			const probes = await pending;
			expect(probes).toHaveLength(3);
			expect(probes.every((p) => !p.success && /timed out after 10s/.test(p.error ?? ""))).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("the whole record", () => {
	const MAC = deps({
		commands: {
			"sw_vers -productVersion": "12.7.6",
			"xcrun simctl list devices available": "== Devices ==",
			"docker info --format {{.ServerVersion}}": "27.0.1",
			"git --version": "git version 2.45.2",
			"gh --version": "gh version 2.60.1 (2026-09-01)\nhttps://github.com/cli/cli/releases/tag/v2.60.1",
			"wrangler --version": " ⛅️ wrangler 4.9.0",
			"pags --version": "0.4.177-rc.2",
			"python3 --version": "Python 3.12.4",
		},
		env: { [SKIP_PROBE_ENV]: "1" },
	});
	it("carries OS, resources, runtime versions, support flags and the inventory (names and versions only)", async () => {
		const c = await detectMachineCapabilities(MAC);
		expect(c).toMatchObject({
			schemaVersion: 1,
			detectedAt: "2026-10-23T00:00:00.000Z",
			os: { name: "macOS", version: "12.7.6", arch: "x64" },
			cpuCount: 4,
			memoryGb: 8,
			diskGb: 250,
			nodeVersion: "22.4.0",
			playwright: { version: "1.58.2", probes: [] },
			ios: true,
			android: false,
			docker: true,
		});
		expect(c.inventory).toEqual([
			{ name: "git", version: "2.45.2" },
			{ name: "gh", version: "2.60.1" },
			{ name: "python3", version: "3.12.4" },
			{ name: "wrangler", version: "4.9.0" },
			{ name: "pags", version: "0.4.177-rc.2" }, // a release candidate keeps its suffix
		]);
	});
	it("only ever reports tools from the fixed list, capped, and nothing path- or user-shaped", async () => {
		const c = await detectMachineCapabilities(MAC);
		const allowed = new Set(INVENTORY_TOOLS.map(([n]) => n));
		expect(c.inventory.every((i) => allowed.has(i.name))).toBe(true);
		expect(c.inventory.length).toBeLessThanOrEqual(INVENTORY_CAP);
		expect(JSON.stringify(c)).not.toMatch(/\/Users|\/home|C:\\|serge|@|token|secret/i);
	});
	it("runs iOS detection on macOS only, and survives every probe failing", async () => {
		const linux = await detectMachineCapabilities(deps({ platform: "linux", release: "6.8.0", env: { [SKIP_PROBE_ENV]: "1" } }));
		expect(linux).toMatchObject({ ios: false, android: false, docker: false, inventory: [] });
	});
	it("hashes the FACTS: re-measuring the same machine does not change it, a changed fact does", async () => {
		const a = await detectMachineCapabilities(MAC);
		const b = await detectMachineCapabilities({ ...MAC, now: () => new Date("2026-10-24T00:00:00Z") });
		expect(capabilityHash(a)).toBe(capabilityHash(b));
		const c = await detectMachineCapabilities({ ...MAC, nodeVersion: "24.0.0" });
		expect(capabilityHash(c)).not.toBe(capabilityHash(a));
	});
});

describe("helpers", () => {
	it("pulls a version token and scrubs paths", () => {
		expect(versionToken("go version go1.23.1 darwin/arm64")).toBe("1.23.1");
		expect(versionToken("no digits here")).toBeNull();
		expect(scrub("failed at C:\\Users\\bob\\x.exe and ~/dir/file and ./rel/path", 200)).toBe("failed at <path> and <path> and <path>");
	});
});

describe("the reporter sends the record once, then only its hash (#1312)", () => {
	it("full record first, hash alone after the platform stored it, full again when it changes or is wanted", async () => {
		let node = "22.0.0";
		const clock = { t: 0 };
		const reporter = new CapabilityReporter(() => detectMachineCapabilities(deps({ nodeVersion: node, env: { [SKIP_PROBE_ENV]: "1" } })), () => clock.t);
		expect(reporter.payload()).toEqual({}); // detection has not finished: nothing to claim yet
		await reporter.settled();
		const first = reporter.payload();
		expect(first.capabilities?.nodeVersion).toBe("22.0.0");
		reporter.accept({ capabilitiesStored: true });
		expect(reporter.payload()).toEqual({ capabilityHash: first.capabilityHash });
		reporter.accept({ capabilitiesWanted: true });
		expect(reporter.payload().capabilities).toBeDefined();
		reporter.accept({ capabilitiesStored: true });
		// Ten minutes on, a re-detection that changed something is sent in full again.
		node = "24.0.0";
		clock.t = 11 * 60_000;
		reporter.payload();
		await reporter.settled();
		expect(reporter.payload().capabilities?.nodeVersion).toBe("24.0.0");
	});
	it("a failing detection never throws and reports nothing", async () => {
		const reporter = new CapabilityReporter(async () => { throw new Error("boom"); });
		reporter.refreshIfDue();
		await reporter.settled();
		expect(reporter.payload()).toEqual({});
	});
});
