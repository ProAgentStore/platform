/**
 * #1057 slice 2 — the native READ tools on RECORDED command outputs: no live screen, device or OS prompt.
 *
 * Invariants: every read answers an envelope (never throws); a denied permission, a missing tool, a
 * timeout and an absent device each come back as their stable code; trees are bounded and say so;
 * nothing but fixed read commands is ever run.
 */
import { describe, expect, it } from "vitest";
import { NATIVE_TREE_MAX_DEPTH, NATIVE_TREE_MAX_NODES } from "./contract.js";
import type { Exec, ExecResult } from "./preflight.js";
import { accessibilityTree, commandFailure, listApps, maestroDevices, maestroHierarchy, maestroTree, treeDepth } from "./read.js";
import { nativeReadRoute } from "./read-route.js";

const ok = (stdout: string): ExecResult => ({ found: true, code: 0, stdout, stderr: "" });
const missing: ExecResult = { found: false, code: null, stdout: "", stderr: "" };
const ADB = "List of devices attached\nemulator-5554          device product:sdk_gphone64 model:sdk_gphone64_arm64 transport_id:1\nR5CT1234XYZ            unauthorized usb:1-1\n";

/** A fake shell answering by command-line prefix (first match wins), recording every command. */
function shell(answers: Array<[string, ExecResult]>) {
	const calls: string[] = [];
	const exec: Exec = async (cmd, args) => {
		const line = [cmd, ...args].join(" ");
		calls.push(line);
		return answers.find(([prefix]) => line.startsWith(prefix))?.[1] ?? missing;
	};
	return { exec, calls };
}
const READ_ONLY = /^(osascript|powershell\.exe|maestro (--version|--device \S+ hierarchy)|adb devices -l|xcrun simctl list devices booted --json)\b/;

describe("native_list_apps", () => {
	it("macOS: the apps with windows, from NSWorkspace — no permission needed, nothing prompted", async () => {
		const { exec, calls } = shell([["osascript", ok(JSON.stringify({ ok: true, data: { apps: [{ name: "WeChat", pid: 812, bundleId: "com.tencent.xinWeChat", frontmost: true }, { name: "Finder", pid: 101, bundleId: "com.apple.finder", frontmost: false }] } }))]]);
		expect(await listApps({ exec, platform: "darwin" })).toEqual({ ok: true, data: { apps: [{ name: "WeChat", pid: 812, bundleId: "com.tencent.xinWeChat", frontmost: true }, { name: "Finder", pid: 101, bundleId: "com.apple.finder" }] } });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatch(/NSWorkspace/);
		expect(calls[0]).not.toMatch(/System Events/);
	});

	it("Windows: Get-Process with a main window — a single app (rendered by PowerShell as an object) is still a list", async () => {
		const { exec } = shell([["powershell.exe", ok(JSON.stringify({ ok: true, data: { apps: { name: "WeChat", pid: 4410, windowTitle: "WeChat" } } }))]]);
		expect(await listApps({ exec, platform: "win32" })).toEqual({ ok: true, data: { apps: [{ name: "WeChat", pid: 4410, windowTitle: "WeChat" }] } });
	});

	it("Linux: a stable unsupported code, and no command run", async () => {
		const { exec, calls } = shell([]);
		expect(await listApps({ exec, platform: "linux" })).toMatchObject({ ok: false, code: "NATIVE_UNSUPPORTED_OS" });
		expect(calls).toEqual([]);
	});

	it("a hung command is NATIVE_TIMEOUT, not a silent wait", async () => {
		const { exec } = shell([["osascript", { found: true, code: 1, stdout: "", stderr: "", timedOut: true }]]);
		expect(await listApps({ exec, platform: "darwin" })).toMatchObject({ ok: false, code: "NATIVE_TIMEOUT" });
	});
});

describe("native_accessibility_tree", () => {
	const TREE = { ok: true, data: { of: "WeChat", nodes: 3, truncated: false, root: { role: "application", name: "WeChat", children: [{ role: "AXWindow", name: "WeChat", children: [{ role: "AXStaticText", value: "Hi from Mum" }] }] } } };

	it("macOS: checks Accessibility first (the report-only API), then reads the named app's tree within its bounds", async () => {
		const { exec, calls } = shell([["osascript -l JavaScript -e ObjC.import(\"ApplicationServices\")", ok("true\n")], ["osascript", ok(JSON.stringify(TREE))]]);
		expect(await accessibilityTree({ app: "WeChat", maxDepth: 3 }, { exec, platform: "darwin" })).toEqual(TREE);
		expect(calls[0]).toMatch(/AXIsProcessTrusted/);
		expect(calls[0]).not.toMatch(/AXIsProcessTrustedWithOptions/); // the variant that prompts
		expect(calls[1]).toMatch(/ WeChat 3 200 200$/);
	});

	it("macOS: Accessibility not granted → NATIVE_PERMISSIONS_MISSING before anything walks the screen", async () => {
		const { exec, calls } = shell([["osascript -l JavaScript -e ObjC.import(\"ApplicationServices\")", ok("false\n")]]);
		expect(await accessibilityTree({}, { exec, platform: "darwin" })).toMatchObject({ ok: false, code: "NATIVE_PERMISSIONS_MISSING", message: expect.stringMatching(/Accessibility/) });
		expect(calls).toHaveLength(1);
	});

	it("macOS: System Events refused (Automation, -1743) → NATIVE_PERMISSIONS_MISSING naming Automation", async () => {
		const { exec } = shell([
			["osascript -l JavaScript -e ObjC.import(\"ApplicationServices\")", ok("true\n")],
			["osascript", { found: true, code: 1, stdout: "", stderr: "execution error: Not authorized to send Apple events to System Events. (-1743)" }],
		]);
		expect(await accessibilityTree({}, { exec, platform: "darwin" })).toMatchObject({ ok: false, code: "NATIVE_PERMISSIONS_MISSING", message: expect.stringMatching(/Automation/) });
	});

	it("Windows: UI Automation, with the app name quoted safely into the script", async () => {
		const { exec, calls } = shell([["powershell.exe", ok(JSON.stringify({ ok: true, data: { of: "Notepad", nodes: 1, truncated: false, root: { role: "Window", name: "Notepad" } } }))]]);
		expect(await accessibilityTree({ app: "O'Brien's app" }, { exec, platform: "win32" })).toMatchObject({ ok: true, data: { of: "Notepad" } });
		expect(calls[0]).toMatch(/'O''Brien''s app' 5 200 200$/);
	});

	it("Linux: unsupported, gracefully", async () => {
		expect(await accessibilityTree({}, { exec: shell([]).exec, platform: "linux" })).toMatchObject({ ok: false, code: "NATIVE_UNSUPPORTED_OS" });
	});

	it("the depth asked for is held inside the contract's bounds", () => {
		expect(treeDepth(undefined)).toBe(5);
		expect(treeDepth(99)).toBe(NATIVE_TREE_MAX_DEPTH);
		expect(treeDepth(0)).toBe(1);
	});
});

describe("Maestro reads", () => {
	it("native_maestro_devices lists every device with its state", async () => {
		const { exec } = shell([["maestro --version", ok("1.39.0\n")], ["adb devices -l", ok(ADB)]]);
		expect(await maestroDevices({ exec, platform: "linux" })).toEqual({
			ok: true,
			data: { maestroInstalled: true, devices: [{ id: "emulator-5554", kind: "android", name: "sdk gphone64 arm64", state: "device" }, { id: "R5CT1234XYZ", kind: "android", name: "R5CT1234XYZ", state: "unauthorized" }] },
		});
	});

	it("Maestro missing → NATIVE_MAESTRO_NOT_INSTALLED, and the runner installs nothing", async () => {
		const { exec, calls } = shell([["adb devices -l", ok(ADB)]]);
		expect(await maestroDevices({ exec, platform: "darwin" })).toMatchObject({ ok: false, code: "NATIVE_MAESTRO_NOT_INSTALLED" });
		expect(calls.every((c) => READ_ONLY.test(c))).toBe(true);
	});

	it("native_maestro_hierarchy reads a ready device, through log lines, into the shared node shape", async () => {
		const hierarchy = { attributes: {}, children: [{ attributes: { class: "android.widget.FrameLayout" }, children: [{ attributes: {}, children: [{ attributes: { text: "Inbox", "resource-id": "com.app:id/title", class: "android.widget.TextView" } }] }] }] };
		const { exec, calls } = shell([["maestro --version", ok("1.39.0")], ["adb devices -l", ok(ADB)], ["maestro --device emulator-5554 hierarchy", ok(`Running on emulator-5554\n${JSON.stringify(hierarchy)}`)]]);
		expect(await maestroHierarchy({ deviceId: "emulator-5554" }, { exec, platform: "linux" })).toEqual({
			ok: true,
			data: { of: "sdk gphone64 arm64", nodes: 2, truncated: false, root: { role: "android.widget.FrameLayout", children: [{ role: "android.widget.TextView", name: "Inbox", id: "com.app:id/title" }] } },
		});
		expect(calls.every((c) => READ_ONLY.test(c))).toBe(true);
	});

	it("an unknown device, or one not ready, is NATIVE_DEVICE_NOT_FOUND — and Maestro is never asked", async () => {
		const { exec, calls } = shell([["maestro --version", ok("1.39.0")], ["adb devices -l", ok(ADB)]]);
		expect(await maestroHierarchy({ deviceId: "nope" }, { exec, platform: "linux" })).toMatchObject({ ok: false, code: "NATIVE_DEVICE_NOT_FOUND", message: expect.stringMatching(/Connected: emulator-5554/) });
		expect(await maestroHierarchy({ deviceId: "R5CT1234XYZ" }, { exec, platform: "linux" })).toMatchObject({ ok: false, code: "NATIVE_DEVICE_NOT_FOUND", message: expect.stringMatching(/unauthorized/) });
		expect(calls.some((c) => c.includes("hierarchy"))).toBe(false);
	});

	it("a hierarchy is bounded by the node cap, and says it was cut", () => {
		const wide = { attributes: { class: "root" }, children: Array.from({ length: NATIVE_TREE_MAX_NODES + 50 }, (_, i) => ({ attributes: { text: `row ${i}`, class: "Text" } })) };
		const tree = maestroTree(wide, "phone");
		expect(tree.nodes).toBe(NATIVE_TREE_MAX_NODES);
		expect(tree.truncated).toBe(true);
	});
});

describe("the route table", () => {
	it("refuses a malformed request with NATIVE_INVALID_REQUEST, and leaves non-read paths alone", async () => {
		expect(await nativeReadRoute("/native/maestro/hierarchy", { deviceId: "bad id; rm -rf" })).toMatchObject({ status: 400, body: { ok: false, code: "NATIVE_INVALID_REQUEST" } });
		expect(await nativeReadRoute("/native/accessibility-tree", { maxDepth: 2.5 })).toMatchObject({ status: 400 });
		expect(await nativeReadRoute("/native/click", {})).toBeNull();
	});

	it("routes a valid read to its handler", async () => {
		const { exec } = shell([["osascript", ok(JSON.stringify({ ok: true, data: { apps: [] } }))]]);
		expect(await nativeReadRoute("/native/list-apps", {}, { exec, platform: "darwin" })).toEqual({ status: 200, body: { ok: true, data: { apps: [] } } });
	});

	it("a failed command names its own last line, cut and marked if long", () => {
		expect(commandFailure({ found: true, code: 2, stdout: "", stderr: `boom ${"x".repeat(400)}` }, "Reading")).toMatchObject({ code: "NATIVE_COMMAND_FAILED", message: expect.stringMatching(/…\.$/) });
	});
});
