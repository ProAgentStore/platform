/**
 * #1057 slice 1 — the native preflight on RECORDED command outputs (no live device, no OS prompt).
 *
 * Invariants: it never throws; it only ever runs read-only probe commands (no install, no
 * permission REQUEST); a missing tool or garbage output becomes a state and a stable error code;
 * the device lists parse what adb/simctl really print.
 */
import { describe, expect, it } from "vitest";
import { type Exec, type ExecResult, parseAdbDevices, parseBooleanProbe, parseMaestroVersion, parseSimctlBooted, runNativePreflight } from "./preflight.js";

const ok = (stdout: string): ExecResult => ({ found: true, code: 0, stdout, stderr: "" });
const missing: ExecResult = { found: false, code: null, stdout: "", stderr: "" };

const ADB = `List of devices attached
emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1
R5CT1234XYZ            unauthorized usb:1-1 transport_id:2

`;
const SIMCTL = JSON.stringify({
	devices: {
		"com.apple.CoreSimulator.SimRuntime.iOS-18-0": [{ udid: "AAAA-1111", name: "iPhone 16", state: "Booted" }],
		"com.apple.CoreSimulator.SimRuntime.iOS-17-5": [{ udid: "BBBB-2222", name: "iPhone 15", state: "Shutdown" }],
	},
});

/** A fake shell that answers by command line and records every command it was asked to run. */
function shell(answers: Record<string, ExecResult | Error>) {
	const calls: string[] = [];
	const exec: Exec = async (cmd, args) => {
		const line = [cmd, ...args].join(" ");
		calls.push(line);
		for (const [prefix, answer] of Object.entries(answers)) {
			if (line.startsWith(prefix)) {
				if (answer instanceof Error) throw answer;
				return answer;
			}
		}
		return missing;
	};
	return { exec, calls };
}

describe("parsers", () => {
	it("a boolean probe: true → granted, false → denied, anything else → unknown", () => {
		expect(parseBooleanProbe(ok("true\n"))).toBe("granted");
		expect(parseBooleanProbe(ok("false\n"))).toBe("denied");
		expect(parseBooleanProbe(ok("maybe"))).toBe("unknown");
		expect(parseBooleanProbe({ found: true, code: 1, stdout: "", stderr: "execution error" })).toBe("unknown");
		expect(parseBooleanProbe(missing)).toBe("unknown");
		expect(parseBooleanProbe({ ...ok("true"), timedOut: true })).toBe("unknown");
	});

	it("adb devices -l: every device with its state and model", () => {
		expect(parseAdbDevices(ADB)).toEqual([
			{ id: "emulator-5554", kind: "android", name: "sdk gphone64 arm64", state: "device" },
			{ id: "R5CT1234XYZ", kind: "android", name: "R5CT1234XYZ", state: "unauthorized" },
		]);
		expect(parseAdbDevices("List of devices attached\n\n")).toEqual([]);
		expect(parseAdbDevices("* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\n")).toEqual([]);
	});

	it("simctl: booted simulators only; garbage reads as none", () => {
		expect(parseSimctlBooted(SIMCTL)).toEqual([{ id: "AAAA-1111", kind: "ios_simulator", name: "iPhone 16", state: "Booted" }]);
		expect(parseSimctlBooted("not json")).toEqual([]);
		expect(parseSimctlBooted("{}")).toEqual([]);
	});

	it("maestro --version", () => {
		expect(parseMaestroVersion(ok("1.39.13\n"))).toBe("1.39.13");
		expect(parseMaestroVersion(missing)).toBeNull();
	});
});

describe("runNativePreflight", () => {
	it("macOS, nothing granted, no Maestro: denied + both codes — and only read-only probes ran", async () => {
		const { exec, calls } = shell({ "sw_vers": ok("15.7.1\n"), "osascript": ok("false\n"), "xcrun simctl": ok("{}") });
		const r = await runNativePreflight({ exec, platform: "darwin", arch: "arm64", now: () => 42 });
		expect(r).toMatchObject({ os: "darwin", osVersion: "15.7.1", arch: "arm64", checkedAt: 42, desktop: { screenRecording: "denied", accessibility: "denied", permissionState: "denied" }, maestro: { installed: false, connectedDevices: [] } });
		expect(r.errors.map((e) => e.code)).toEqual(["NATIVE_PERMISSIONS_MISSING", "NATIVE_MAESTRO_NOT_INSTALLED"]);
		expect(r.errors[0].message).toMatch(/Screen Recording and Accessibility/);
		// The probes are the PREFLIGHT (report-only) APIs — never a request that would prompt — and nothing installs.
		expect(calls.join("\n")).toMatch(/CGPreflightScreenCaptureAccess/);
		expect(calls.join("\n")).toMatch(/AXIsProcessTrusted\(\)/);
		expect(calls.join("\n")).not.toMatch(/CGRequestScreenCaptureAccess|AXIsProcessTrustedWithOptions|install|brew|npm|curl|screencapture/);
	});

	it("macOS, everything ready: granted, devices listed, no errors", async () => {
		const { exec } = shell({ "sw_vers": ok("15.7.1"), "osascript": ok("true"), "maestro": ok("1.39.13"), "adb": ok(ADB), "xcrun simctl": ok(SIMCTL) });
		const r = await runNativePreflight({ exec, platform: "darwin", arch: "arm64", now: () => 1 });
		expect(r.desktop.permissionState).toBe("granted");
		expect(r.maestro).toMatchObject({ installed: true, version: "1.39.13", adbInstalled: true, simctlAvailable: true });
		expect(r.maestro.connectedDevices.map((d) => d.id)).toEqual(["emulator-5554", "R5CT1234XYZ", "AAAA-1111"]);
		expect(r.errors).toEqual([]);
	});

	it("Maestro installed but only an unauthorised phone: NATIVE_DEVICE_NOT_FOUND naming it", async () => {
		const { exec } = shell({ "sw_vers": ok("15"), "osascript": ok("true"), "maestro": ok("1.39.13"), "adb": ok("List of devices attached\nR5CT1234XYZ unauthorized usb:1-1\n") });
		const r = await runNativePreflight({ exec, platform: "darwin", arch: "arm64", now: () => 1 });
		expect(r.errors).toEqual([{ code: "NATIVE_DEVICE_NOT_FOUND", message: expect.stringMatching(/R5CT1234XYZ \(unauthorized\)/) }]);
	});

	it("Windows: one UI Automation probe decides both desktop states; no simctl", async () => {
		const { exec, calls } = shell({ "powershell.exe": ok("true") });
		const r = await runNativePreflight({ exec, platform: "win32", arch: "x64", now: () => 1 });
		expect(r.desktop).toEqual({ screenRecording: "granted", accessibility: "granted", permissionState: "granted" });
		expect(calls.some((c) => c.startsWith("xcrun"))).toBe(false);
		expect(r.errors.map((e) => e.code)).toEqual(["NATIVE_MAESTRO_NOT_INSTALLED"]);
	});

	it("Linux: desktop unsupported, said so", async () => {
		const r = await runNativePreflight({ exec: shell({}).exec, platform: "linux", arch: "x64", now: () => 1 });
		expect(r.desktop.permissionState).toBe("unsupported");
		expect(r.errors.map((e) => e.code)).toContain("NATIVE_UNSUPPORTED_OS");
	});

	it("never throws — a probe that throws reads as unknown / not installed", async () => {
		const boom = new Error("spawn EPERM");
		const { exec } = shell({ "sw_vers": boom, "osascript": boom, "maestro": boom, "adb": boom, "xcrun": boom });
		const r = await runNativePreflight({ exec, platform: "darwin", arch: "arm64", now: () => 1 });
		expect(r.desktop.permissionState).toBe("unknown");
		expect(r.maestro.installed).toBe(false);
	});
});
