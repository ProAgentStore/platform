/**
 * `/native/preflight` (#1057, slice 1): what this machine could do for the `local_native` runtime
 * — desktop control permissions and Maestro devices — WITHOUT doing any of it.
 *
 * Rules this module keeps:
 *   - READ-ONLY. It runs fixed probe commands and installs nothing. It never prompts for an OS
 *     permission either: on macOS the two checks are the "preflight" APIs that only report state
 *     (`CGPreflightScreenCaptureAccess`, `AXIsProcessTrusted`), not the "request" ones that open a
 *     system dialog. (`screencapture` is NOT used as the probe: without Screen Recording it still
 *     exits 0 and captures only the wallpaper, so its exit code proves nothing.)
 *   - NEVER THROWS. A missing tool, a timeout or garbage output becomes a state (`unknown`, not
 *     installed, no devices) and a stable error code with a sentence the owner can act on.
 *   - Parsing is pure and exported, so it is tested on recorded outputs — no live device needed.
 *
 * `adb devices` starts the adb server if it is not already running; that is adb's own behaviour
 * when asked to list devices, not something installed or configured here.
 */
import { execFile } from "node:child_process";
import { arch as osArch, platform as osPlatform } from "node:os";
import type { NativeDevice, NativeErrorCode, NativePermissionState, NativePreflightResult } from "./contract.js";

export interface ExecResult {
	/** False when the binary is not on PATH (ENOENT). */
	found: boolean;
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
}

export type Exec = (cmd: string, args: string[], timeoutMs?: number) => Promise<ExecResult>;

/** Run one probe command; never rejects. */
export const execProbe: Exec = (cmd, args, timeoutMs = 8000) =>
	new Promise((resolve) => {
		execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
			const e = err as (NodeJS.ErrnoException & { code?: string | number; killed?: boolean }) | null;
			if (e?.code === "ENOENT") return resolve({ found: false, code: null, stdout: "", stderr: "" });
			resolve({
				found: true,
				code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
				stdout: String(stdout ?? ""),
				stderr: String(stderr ?? ""),
				...(e?.killed ? { timedOut: true } : {}),
			});
		});
	});

// ── Pure parsers ────────────────────────────────────────────────────────────

/** `osascript -l JavaScript` printing `true`/`false` → a permission state. */
export function parseBooleanProbe(r: ExecResult): NativePermissionState {
	if (!r.found || r.timedOut || r.code !== 0) return "unknown";
	const out = r.stdout.trim().toLowerCase();
	return out === "true" ? "granted" : out === "false" ? "denied" : "unknown";
}

/** `maestro --version` → its version, or null when it printed nothing recognisable. */
export function parseMaestroVersion(r: ExecResult): string | null {
	if (!r.found || r.code !== 0) return null;
	const m = r.stdout.match(/\d+\.\d+(?:\.\d+)?/);
	if (m) return m[0];
	// No version number: keep a short first line verbatim, and refuse a long one rather than cut it.
	const first = r.stdout.trim().split("\n")[0] ?? "";
	return first && first.length <= 40 ? first : null;
}

/** `adb devices -l` → attached devices (any state; `device` is the usable one). */
export function parseAdbDevices(stdout: string): NativeDevice[] {
	const out: NativeDevice[] = [];
	for (const line of stdout.split("\n")) {
		const t = line.trim();
		if (!t || t.startsWith("List of devices") || t.startsWith("*")) continue;
		const [id, state, ...rest] = t.split(/\s+/);
		if (!id || !state) continue;
		const model = rest.find((p) => p.startsWith("model:"))?.slice("model:".length);
		out.push({ id, kind: "android", name: model ? model.replace(/_/g, " ") : id, state });
	}
	return out;
}

/** `xcrun simctl list devices booted --json` → booted simulators. */
export function parseSimctlBooted(stdout: string): NativeDevice[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	const devices = (parsed as { devices?: Record<string, unknown> })?.devices;
	if (!devices || typeof devices !== "object") return [];
	const out: NativeDevice[] = [];
	for (const list of Object.values(devices)) {
		if (!Array.isArray(list)) continue;
		for (const d of list as Array<{ udid?: unknown; name?: unknown; state?: unknown }>) {
			if (typeof d?.udid !== "string" || d.state !== "Booted") continue;
			out.push({ id: d.udid, kind: "ios_simulator", name: typeof d.name === "string" ? d.name : d.udid, state: "Booted" });
		}
	}
	return out;
}

/** Combine the parts into one result with its error codes. Pure. */
export function summarizePreflight(input: {
	os: string;
	osVersion: string | null;
	arch: string;
	screenRecording: NativePermissionState;
	accessibility: NativePermissionState;
	maestroVersion: string | null;
	maestroInstalled: boolean;
	adbInstalled: boolean;
	simctlAvailable: boolean;
	devices: NativeDevice[];
	checkedAt: number;
}): NativePreflightResult {
	const { screenRecording, accessibility } = input;
	const states = [screenRecording, accessibility];
	const permissionState: NativePermissionState = states.includes("unsupported")
		? "unsupported"
		: states.includes("denied")
			? "denied"
			: states.every((s) => s === "granted")
				? "granted"
				: "unknown";
	const errors: NativePreflightResult["errors"] = [];
	const add = (code: NativeErrorCode, message: string) => errors.push({ code, message });
	if (permissionState === "unsupported") add("NATIVE_UNSUPPORTED_OS", `Desktop control is not supported on ${input.os} yet (macOS and Windows only).`);
	if (permissionState === "denied") {
		const missing = [screenRecording === "denied" ? "Screen Recording" : null, accessibility === "denied" ? "Accessibility" : null].filter(Boolean).join(" and ");
		add("NATIVE_PERMISSIONS_MISSING", `This machine has not granted ${missing}. Grant it to the app that runs \`pags up\` (e.g. Terminal) in System Settings → Privacy & Security, then restart \`pags up\`.`);
	}
	if (!input.maestroInstalled) add("NATIVE_MAESTRO_NOT_INSTALLED", "Maestro is not installed on this machine. The runner never installs it; install it yourself (https://maestro.mobile.dev) if you want phone or emulator automation.");
	const usable = input.devices.filter((d) => d.state === "device" || d.state === "Booted");
	if (input.maestroInstalled && usable.length === 0) {
		add("NATIVE_DEVICE_NOT_FOUND", input.devices.length ? `No usable device: ${input.devices.map((d) => `${d.name} (${d.state})`).join(", ")}. Authorise or boot one.` : "No Android device/emulator or booted iOS simulator is connected.");
	}
	return {
		os: input.os,
		osVersion: input.osVersion,
		arch: input.arch,
		desktop: { screenRecording, accessibility, permissionState },
		maestro: { installed: input.maestroInstalled, version: input.maestroVersion, adbInstalled: input.adbInstalled, simctlAvailable: input.simctlAvailable, connectedDevices: input.devices },
		errors,
		checkedAt: input.checkedAt,
	};
}

// ── The probe ───────────────────────────────────────────────────────────────

// CGPreflightScreenCaptureAccess is not in JXA's bridge metadata, so it is bound explicitly —
// without the bind the call is "not a function" and the state would read `unknown`.
const JXA_SCREEN = 'ObjC.import("CoreGraphics"); ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]); $.CGPreflightScreenCaptureAccess()';
const JXA_AX = 'ObjC.import("ApplicationServices"); $.AXIsProcessTrusted()';
const PS_UIA = "Add-Type -AssemblyName UIAutomationClient; if ([System.Windows.Automation.AutomationElement]::RootElement) { 'true' } else { 'false' }";

export async function runNativePreflight(deps: { exec?: Exec; platform?: NodeJS.Platform; arch?: string; now?: () => number } = {}): Promise<NativePreflightResult> {
	const exec = deps.exec ?? execProbe;
	const platform = deps.platform ?? osPlatform();
	const safe = (p: Promise<ExecResult>) => p.catch((): ExecResult => ({ found: false, code: null, stdout: "", stderr: "" }));

	let osVersion: string | null = null;
	let screenRecording: NativePermissionState = "unsupported";
	let accessibility: NativePermissionState = "unsupported";
	if (platform === "darwin") {
		const [ver, screen, ax] = await Promise.all([safe(exec("sw_vers", ["-productVersion"])), safe(exec("osascript", ["-l", "JavaScript", "-e", JXA_SCREEN])), safe(exec("osascript", ["-l", "JavaScript", "-e", JXA_AX]))]);
		osVersion = ver.code === 0 ? ver.stdout.trim() || null : null;
		screenRecording = parseBooleanProbe(screen);
		accessibility = parseBooleanProbe(ax);
	} else if (platform === "win32") {
		// Windows has no per-app permission for screen capture or UI Automation: one availability probe.
		const uia = parseBooleanProbe(await safe(exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_UIA], 15000)));
		screenRecording = uia;
		accessibility = uia;
	}

	const [maestro, adb, simctl] = await Promise.all([
		safe(exec("maestro", ["--version"], 15000)),
		safe(exec("adb", ["devices", "-l"])),
		platform === "darwin" ? safe(exec("xcrun", ["simctl", "list", "devices", "booted", "--json"])) : Promise.resolve<ExecResult>({ found: false, code: null, stdout: "", stderr: "" }),
	]);
	const devices = [...(adb.found && adb.code === 0 ? parseAdbDevices(adb.stdout) : []), ...(simctl.found && simctl.code === 0 ? parseSimctlBooted(simctl.stdout) : [])];
	return summarizePreflight({
		os: platform,
		osVersion,
		arch: deps.arch ?? osArch(),
		screenRecording,
		accessibility,
		maestroVersion: parseMaestroVersion(maestro),
		maestroInstalled: maestro.found && maestro.code === 0,
		adbInstalled: adb.found,
		simctlAvailable: simctl.found && simctl.code === 0,
		devices,
		checkedAt: (deps.now ?? Date.now)(),
	});
}
