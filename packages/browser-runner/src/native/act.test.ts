/**
 * #1057 slice 3 — the native ACT tools against a FAKE shell: no live screen, mouse, keyboard or app is touched.
 *
 * Invariants: what a model supplies reaches the OS as argv (or base64), never inside script source; halt refuses everything
 * and only resume clears it; typing refuses a password field; a screenshot is saved privately and its pixels never returned;
 * a denied permission, a missing app and a timeout each come back as their stable code.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type ActDeps, type HaltState, MAC_KEY_CODES, click, halt, launchApp, macOpenArgs, pressKey, psQuote, resume, screenshot, scroll, type ShotFiles, typeText, windowsSendKeys } from "./act.js";
import { nativeActRoute } from "./act-route.js";
import { NATIVE_SHOTS_KEPT, nativeActInputError, parseNativeKey } from "./contract.js";
import type { Exec, ExecResult } from "./preflight.js";

const ok = (stdout = ""): ExecResult => ({ found: true, code: 0, stdout, stderr: "" });
const DONE = JSON.stringify({ ok: true, data: { done: true } });
const missing: ExecResult = { found: false, code: null, stdout: "", stderr: "" };

/** A fake shell answering by command-line substring (first match wins), recording every command and its argv. */
function shell(answers: Array<[string, ExecResult]>, fallback: ExecResult = ok(DONE)) {
	const calls: Array<{ cmd: string; args: string[]; line: string }> = [];
	const exec: Exec = async (cmd, args) => {
		const line = [cmd, ...args].join(" ");
		calls.push({ cmd, args, line });
		return answers.find(([needle]) => line.includes(needle))?.[1] ?? fallback;
	};
	return { exec, calls };
}
const AX_OK = ["AXIsProcessTrusted", ok("true")] as [string, ExecResult];
const NOT_SECURE = ["AXSecureTextField", ok(JSON.stringify({ secure: false }))] as [string, ExecResult];
const newHalt = (): HaltState => ({ halted: false });

describe("input is bounded before it reaches a machine", () => {
	it("accepts well-formed input and refuses the rest, in the contract's own words", () => {
		expect(nativeActInputError("native_click", { x: 10, y: 20 })).toBeNull();
		expect(nativeActInputError("native_click", { x: -1, y: 20 })).toMatch(/whole screen coordinates/);
		expect(nativeActInputError("native_click", { x: 1.5, y: 2 })).toMatch(/whole screen coordinates/);
		expect(nativeActInputError("native_click", { x: 1, y: 2, button: "middle" })).toMatch(/button/);
		expect(nativeActInputError("native_type", { text: "" })).toMatch(/characters/);
		expect(nativeActInputError("native_type", { text: "x".repeat(2001) })).toMatch(/characters/);
		expect(nativeActInputError("native_key", { key: "cmd+a" })).toBeNull();
		expect(nativeActInputError("native_key", { key: "cmd+cmd+a" })).toMatch(/key/);
		expect(nativeActInputError("native_key", { key: "hyper+a" })).toMatch(/key/);
		expect(nativeActInputError("native_scroll", { dy: 0 })).toMatch(/not both zero/);
		expect(nativeActInputError("native_scroll", { dy: -3 })).toBeNull();
		expect(nativeActInputError("native_launch_app", { app: "WeChat" })).toBeNull();
		expect(nativeActInputError("native_launch_app", { app: "/Applications/Evil.app" })).toMatch(/never a path/);
		expect(nativeActInputError("native_launch_app", { app: "a; rm -rf ~" })).toMatch(/never a path/);
		expect(nativeActInputError("native_click", { x: 1, y: 2, why: "w".repeat(301) })).toMatch(/why/);
	});

	it("parses a key spec: modifiers in any order, no repeats, one key", () => {
		expect(parseNativeKey("ctrl+shift+T")).toEqual({ modifiers: ["ctrl", "shift"], key: "t" });
		expect(parseNativeKey("return")).toEqual({ modifiers: [], key: "return" });
		expect(parseNativeKey("cmd+")).toBeNull();
		expect(parseNativeKey("ab")).toBeNull();
		expect(parseNativeKey(42)).toBeNull();
	});
});

describe("pure builders", () => {
	it("Windows SendKeys: modifiers become ^ % +, named keys their braces, and cmd has no form", () => {
		expect(windowsSendKeys("ctrl+shift+t")).toBe("^+t");
		expect(windowsSendKeys("alt+f4")).toBe("%{F4}");
		expect(windowsSendKeys("return")).toBe("{ENTER}");
		expect(windowsSendKeys("cmd+a")).toBeNull();
	});
	it("macOS open: a bundle id opens by id, a name by name", () => {
		expect(macOpenArgs("com.tencent.xinWeChat")).toEqual(["-b", "com.tencent.xinWeChat"]);
		expect(macOpenArgs("WeChat")).toEqual(["-a", "WeChat"]);
	});
	it("a PowerShell literal doubles its quotes", () => {
		expect(psQuote("it's")).toBe("'it''s'");
	});
	it("every named key has a macOS key code", () => {
		for (const k of ["return", "tab", "escape", "space", "delete", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "f1", "f12"]) expect(MAC_KEY_CODES[k], k).toBeTypeOf("number");
	});
});

describe("launch", () => {
	it("macOS: `open -a <name>` — the name is an argument, nothing is built into a shell line", async () => {
		const { exec, calls } = shell([["open", ok()]]);
		expect(await launchApp({ app: "WeChat" }, { exec, platform: "darwin", halt: newHalt() })).toEqual({ ok: true, data: { done: true } });
		expect(calls).toEqual([expect.objectContaining({ cmd: "open", args: ["-a", "WeChat"] })]);
	});
	it("macOS: an unknown app says so and points at native_list_apps", async () => {
		const { exec } = shell([["open", { found: true, code: 1, stdout: "", stderr: "Unable to find application named 'Nope'" }]]);
		const r = await launchApp({ app: "Nope" }, { exec, platform: "darwin", halt: newHalt() });
		expect(r).toMatchObject({ ok: false, code: "NATIVE_COMMAND_FAILED" });
		expect((r as { message: string }).message).toMatch(/native_list_apps/);
	});
	it("Windows: Start-Process with the name quoted as data", async () => {
		const { exec, calls } = shell([["powershell.exe", ok(DONE)]]);
		await launchApp({ app: "O'Brien Chat" }, { exec, platform: "win32", halt: newHalt() });
		expect(calls[0].args.at(-1)).toContain("Start-Process -FilePath 'O''Brien Chat'");
	});
	it("Linux is refused with its code", async () => {
		expect(await launchApp({ app: "x" }, { exec: shell([]).exec, platform: "linux", halt: newHalt() })).toMatchObject({ ok: false, code: "NATIVE_UNSUPPORTED_OS" });
	});
});

describe("click, key and scroll", () => {
	it("macOS click passes the coordinates as argv, after checking Accessibility with the report-only probe", async () => {
		const { exec, calls } = shell([AX_OK]);
		expect(await click({ x: 120, y: 340, button: "right", double: true }, { exec, platform: "darwin", halt: newHalt() })).toMatchObject({ ok: true });
		expect(calls[0].line).toMatch(/AXIsProcessTrusted/);
		expect(calls[1].args.slice(-4)).toEqual(["120", "340", "right", "true"]);
		// The script text itself (the `-e` argument) carries no coordinates: they are data.
		expect(calls[1].args[3]).not.toContain("120");
	});
	it("macOS: a denied Accessibility is NATIVE_PERMISSIONS_MISSING and nothing is clicked", async () => {
		const { exec, calls } = shell([["AXIsProcessTrusted", ok("false")]]);
		expect(await click({ x: 1, y: 2 }, { exec, platform: "darwin", halt: newHalt() })).toMatchObject({ ok: false, code: "NATIVE_PERMISSIONS_MISSING" });
		expect(calls).toHaveLength(1);
	});
	it("Windows click moves the cursor, then presses and releases", async () => {
		const { exec, calls } = shell([]);
		await click({ x: 5, y: 6 }, { exec, platform: "win32", halt: newHalt() });
		const s = calls[0].args.at(-1) as string;
		expect(s).toContain("SetCursorPos(5,6)");
		expect(s).toContain("mouse_event(2,");
		expect(s).toContain("mouse_event(4,");
	});
	it("macOS key: a named key goes by its code, with modifiers", async () => {
		const { exec, calls } = shell([AX_OK]);
		await pressKey({ key: "cmd+return" }, { exec, platform: "darwin", halt: newHalt() });
		expect(calls[1].args.slice(-3)).toEqual(["", "36", "command down"]);
	});
	it("macOS key: a letter is typed with the modifier", async () => {
		const { exec, calls } = shell([AX_OK]);
		await pressKey({ key: "cmd+shift+a" }, { exec, platform: "darwin", halt: newHalt() });
		expect(calls[1].args.slice(-3)).toEqual(["a", "", "command down,shift down"]);
	});
	it("Windows key: cmd is refused with the way out, ctrl works", async () => {
		const { exec, calls } = shell([]);
		expect(await pressKey({ key: "cmd+a" }, { exec, platform: "win32", halt: newHalt() })).toMatchObject({ ok: false, code: "NATIVE_INVALID_REQUEST" });
		expect(calls).toHaveLength(0);
		await pressKey({ key: "ctrl+a" }, { exec, platform: "win32", halt: newHalt() });
		expect(calls[0].args.at(-1)).toContain("SendWait('^a')");
	});
	it("scroll: vertical lines then horizontal, as argv on macOS and wheel deltas on Windows", async () => {
		const mac = shell([AX_OK]);
		await scroll({ dy: -5, dx: 2 }, { exec: mac.exec, platform: "darwin", halt: newHalt() });
		expect(mac.calls[1].args.slice(-2)).toEqual(["-5", "2"]);
		const win = shell([]);
		await scroll({ dy: -2 }, { exec: win.exec, platform: "win32", halt: newHalt() });
		expect(win.calls[0].args.at(-1)).toContain("mouse_event(0x0800,0,0,-240");
	});
});

describe("typing", () => {
	it("macOS: the text is argv — a hostile string cannot become script", async () => {
		const evil = `"); do shell script "rm -rf ~"; ("`;
		const { exec, calls } = shell([AX_OK, NOT_SECURE]);
		expect(await typeText({ text: evil }, { exec, platform: "darwin", halt: newHalt() })).toMatchObject({ ok: true });
		const typed = calls.at(-1);
		expect(typed?.args.at(-1)).toBe(evil);
		expect(typed?.args[3]).not.toContain("rm -rf");
	});
	it("Windows: the text rides as base64, so quotes and newlines are inert", async () => {
		const text = "line1'\nline2 \"q\" $(whoami)";
		const { exec, calls } = shell([["AutomationElement", ok(JSON.stringify({ secure: false }))]]);
		await typeText({ text }, { exec, platform: "win32", halt: newHalt() });
		const script = calls.at(-1)?.args.at(-1) as string;
		expect(script).toContain(Buffer.from(text, "utf8").toString("base64"));
		expect(script).not.toContain("whoami");
	});
	it("refuses a password field, on both platforms, and types nothing", async () => {
		const mac = shell([AX_OK, ["AXSecureTextField", ok(JSON.stringify({ secure: true }))]]);
		expect(await typeText({ text: "hunter2" }, { exec: mac.exec, platform: "darwin", halt: newHalt() })).toMatchObject({ ok: false, code: "NATIVE_SECURE_FIELD" });
		expect(mac.calls.some((c) => c.args.at(-1) === "hunter2")).toBe(false);
		const win = shell([["AutomationElement", ok(JSON.stringify({ secure: true }))]]);
		expect(await typeText({ text: "hunter2" }, { exec: win.exec, platform: "win32", halt: newHalt() })).toMatchObject({ ok: false, code: "NATIVE_SECURE_FIELD" });
		expect(win.calls).toHaveLength(1);
	});
	it("an unreadable focus is not treated as secure (best-effort guard: the owner's approval is the real one)", async () => {
		const { exec } = shell([AX_OK, ["AXSecureTextField", { found: true, code: 1, stdout: "", stderr: "boom" }]]);
		expect(await typeText({ text: "hello" }, { exec, platform: "darwin", halt: newHalt() })).toMatchObject({ ok: true });
	});
});

describe("halt", () => {
	it("refuses every act tool with NATIVE_HALTED, runs no command, and only resume clears it", async () => {
		const state = newHalt();
		const { exec, calls } = shell([AX_OK, NOT_SECURE]);
		const deps: ActDeps = { exec, platform: "darwin", halt: state };
		expect(halt(deps)).toEqual({ ok: true, data: { halted: true } });
		for (const r of [await launchApp({ app: "WeChat" }, deps), await click({ x: 1, y: 1 }, deps), await typeText({ text: "a" }, deps), await pressKey({ key: "a" }, deps), await scroll({ dy: 1 }, deps), await screenshot(deps)]) {
			expect(r).toMatchObject({ ok: false, code: "NATIVE_HALTED" });
		}
		expect(calls).toHaveLength(0);
		resume(deps);
		expect(await click({ x: 1, y: 1 }, deps)).toMatchObject({ ok: true });
	});
	it("the routes: halt and resume answer, and a halted runner refuses an act route before touching anything", async () => {
		const state = newHalt();
		const { exec, calls } = shell([AX_OK]);
		const deps: ActDeps = { exec, platform: "darwin", halt: state };
		expect((await nativeActRoute("/native/halt", {}, deps))?.body).toEqual({ ok: true, data: { halted: true } });
		expect((await nativeActRoute("/native/click", { x: 1, y: 1 }, deps))?.body).toMatchObject({ ok: false, code: "NATIVE_HALTED" });
		expect(calls).toHaveLength(0);
		expect((await nativeActRoute("/native/resume", {}, deps))?.body).toEqual({ ok: true, data: { halted: false } });
	});
});

describe("screenshot", () => {
	function fakeFiles(sizeOf: (p: string) => number | null = () => 4096) {
		const removed: string[] = [];
		const written = new Map<string, Buffer>();
		const files: ShotFiles = {
			mkdir: () => undefined,
			stat: (p) => (sizeOf(p) === null ? null : { size: sizeOf(p) as number }),
			read: () => Buffer.from("PNGBYTES"),
			chmod: (p, m) => void written.set(`chmod:${p}`, Buffer.from(String(m))),
			list: () => Array.from({ length: NATIVE_SHOTS_KEPT + 3 }, (_, i) => `shot-${1000 + i}.png`).concat("notes.txt"),
			remove: (p) => void removed.push(p),
		};
		return { files, removed, written };
	}
	it("macOS: screencapture to a private file; returns the PATH, size and hash — never the pixels", async () => {
		const { exec, calls } = shell([["CGPreflightScreenCaptureAccess", ok("true")], ["screencapture", ok()]]);
		const { files, written } = fakeFiles();
		const r = await screenshot({ exec, platform: "darwin", halt: newHalt(), files, shotDir: "/shots", now: () => 5000 });
		expect(r).toEqual({ ok: true, data: { path: "/shots/shot-5000.png", bytes: 4096, sha256: createHash("sha256").update("PNGBYTES").digest("hex") } });
		expect(JSON.stringify(r)).not.toContain("PNGBYTES");
		expect(calls.at(-1)).toMatchObject({ cmd: "screencapture", args: ["-x", "-t", "png", "/shots/shot-5000.png"] });
		expect(written.get("chmod:/shots/shot-5000.png")?.toString()).toBe(String(0o600));
	});
	it("macOS: without Screen Recording it refuses, instead of 'succeeding' with a picture of the wallpaper", async () => {
		const { exec, calls } = shell([["CGPreflightScreenCaptureAccess", ok("false")]]);
		expect(await screenshot({ exec, platform: "darwin", halt: newHalt(), files: fakeFiles().files })).toMatchObject({ ok: false, code: "NATIVE_PERMISSIONS_MISSING" });
		expect(calls.some((c) => c.cmd === "screencapture")).toBe(false);
	});
	it("keeps the newest few and deletes the older shots, leaving other files alone", async () => {
		const { exec } = shell([["CGPreflightScreenCaptureAccess", ok("true")], ["screencapture", ok()]]);
		const { files, removed } = fakeFiles();
		await screenshot({ exec, platform: "darwin", halt: newHalt(), files, shotDir: "/shots", now: () => 1 });
		expect(removed).toEqual(["/shots/shot-1000.png", "/shots/shot-1001.png", "/shots/shot-1002.png"]);
	});
	it("an empty or missing file is a failure, not an image", async () => {
		const { exec } = shell([["CGPreflightScreenCaptureAccess", ok("true")], ["screencapture", ok()]]);
		expect(await screenshot({ exec, platform: "darwin", halt: newHalt(), files: fakeFiles(() => 0).files })).toMatchObject({ ok: false, code: "NATIVE_COMMAND_FAILED" });
		expect(await screenshot({ exec, platform: "darwin", halt: newHalt(), files: fakeFiles(() => null).files })).toMatchObject({ ok: false, code: "NATIVE_COMMAND_FAILED" });
	});
	it("Windows: a PowerShell capture to the same private folder", async () => {
		const { exec, calls } = shell([["powershell.exe", ok(DONE)]]);
		const r = await screenshot({ exec, platform: "win32", halt: newHalt(), files: fakeFiles().files, shotDir: "C:\\shots", now: () => 7 });
		expect(r).toMatchObject({ ok: true });
		expect(calls[0].args.at(-1)).toContain("CopyFromScreen");
	});
});

describe("failures are codes, never silence or a throw", () => {
	it("a timeout, a missing binary and a thrown exec each answer an envelope", async () => {
		const timeout = shell([["open", { found: true, code: null, stdout: "", stderr: "", timedOut: true }]]);
		expect(await launchApp({ app: "X" }, { exec: timeout.exec, platform: "darwin", halt: newHalt() })).toMatchObject({ ok: false, code: "NATIVE_TIMEOUT" });
		const none = shell([["open", missing]]);
		expect(await launchApp({ app: "X" }, { exec: none.exec, platform: "darwin", halt: newHalt() })).toMatchObject({ ok: false });
		const thrown: Exec = async () => {
			throw new Error("spawn exploded");
		};
		expect(await click({ x: 1, y: 1 }, { exec: thrown, platform: "win32", halt: newHalt() })).toMatchObject({ ok: false });
	});
	it("an invalid request is a 400 with NATIVE_INVALID_REQUEST before anything runs", async () => {
		const { exec, calls } = shell([]);
		const r = await nativeActRoute("/native/click", { x: "1", y: 2 }, { exec, platform: "darwin", halt: newHalt() });
		expect(r).toMatchObject({ status: 400, body: { ok: false, code: "NATIVE_INVALID_REQUEST" } });
		expect(calls).toHaveLength(0);
		expect(await nativeActRoute("/native/nope", {}, { exec })).toBeNull();
	});
});
