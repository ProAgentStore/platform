/**
 * The native ACT tools (#1057, slice 3): launch an app, click, type, press a key, scroll, take a screenshot — and the halt
 * that stops them all.
 *
 * What keeps this from being a way to act as the owner without them knowing:
 *   - Everything the model supplies reaches the OS as ARGV (or a base64 blob PowerShell decodes), never spliced into script
 *     source — there is no string a model can write that becomes code. `nativeActInputError` has already bounded every field.
 *   - HALT is a flag on the runner. While it is set every act route answers NATIVE_HALTED and does nothing, even if the cloud
 *     cannot be reached; only {@link resume} (the owner's route) clears it.
 *   - Typing refuses a password field when the OS says the focused element is one. That is best-effort — an app that does not
 *     expose its focus is not caught — so the real safeguard is that the owner approves each `native_type` seeing its exact text.
 *   - A screenshot is written to a private folder on THIS machine and its path returned. The pixels are never returned: they
 *     can hold anything on the owner's screen, and a tool result reaches a model and a log.
 *   - Nothing is logged here. The cloud's audit records the tool, the machine, counts and codes — never text or pixels.
 *
 * Same rules as the reads: never throws; every outcome is a {@link NativeReadResult} (data, or a stable code with a sentence);
 * the cloud, not this file, checks the owner's opt-in and approves consequential calls. The OS scripts here are exercised
 * through a fake `exec` in tests — they have NOT been run against a live screen (that is the owner's acceptance run).
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { type NativeActDone, type NativeErrorCode, type NativeHaltData, type NativeModifier, type NativeReadResult, type NativeScreenshotData, NATIVE_READ_TIMEOUT_MS, NATIVE_SHOTS_KEPT, parseNativeKey } from "./contract.js";
import { type Exec, type ExecResult, execProbe, parseBooleanProbe } from "./preflight.js";
import { commandFailure, parseEnvelope } from "./read.js";

export interface ShotFiles {
	mkdir(dir: string): void;
	stat(path: string): { size: number } | null;
	read(path: string): Buffer;
	chmod(path: string, mode: number): void;
	list(dir: string): string[];
	remove(path: string): void;
}
const realFiles: ShotFiles = {
	mkdir: (d) => void mkdirSync(d, { recursive: true, mode: 0o700 }),
	stat: (p) => {
		try {
			return { size: statSync(p).size };
		} catch {
			return null;
		}
	},
	read: (p) => readFileSync(p),
	chmod: (p, m) => chmodSync(p, m),
	list: (d) => {
		try {
			return readdirSync(d);
		} catch {
			return [];
		}
	},
	remove: (p) => rmSync(p, { force: true }),
};

/** The halt flag: one per runner. Owned here so a test can hold its own. */
export interface HaltState {
	halted: boolean;
}
export const runnerHalt: HaltState = { halted: false };

export interface ActDeps {
	exec?: Exec;
	platform?: NodeJS.Platform;
	halt?: HaltState;
	files?: ShotFiles;
	shotDir?: string;
	now?: () => number;
}

const fail = <T>(code: NativeErrorCode, message: string): NativeReadResult<T> => ({ ok: false, code, message });
const safe = (p: Promise<ExecResult>) => p.catch((): ExecResult => ({ found: false, code: null, stdout: "", stderr: "" }));
const DONE: NativeReadResult<NativeActDone> = { ok: true, data: { done: true } };
const UNSUPPORTED = (platform: string) => fail<never>("NATIVE_UNSUPPORTED_OS", `Desktop control is not supported on ${platform} yet (macOS and Windows only).`);
const PERMISSION_HINT = "Grant it to the app that runs `pags up` (e.g. Terminal) in System Settings → Privacy & Security, then restart `pags up`.";

export const HALTED_MESSAGE = "Native control is halted on this machine. Nothing was done. Only the owner can resume it.";

function guard(deps: ActDeps): NativeReadResult<never> | null {
	return (deps.halt ?? runnerHalt).halted ? fail("NATIVE_HALTED", HALTED_MESSAGE) : null;
}

// ── Pure builders (tested on their output, no screen needed) ─────────────────────────────

const MAC_MODIFIER: Record<NativeModifier, string> = { cmd: "command down", ctrl: "control down", alt: "option down", shift: "shift down" };
/** macOS virtual key codes for the named keys. */
export const MAC_KEY_CODES: Record<string, number> = { return: 36, tab: 48, escape: 53, space: 49, delete: 51, left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111 };
const WIN_KEYS: Record<string, string> = { return: "{ENTER}", tab: "{TAB}", escape: "{ESC}", space: " ", delete: "{BACKSPACE}", left: "{LEFT}", right: "{RIGHT}", down: "{DOWN}", up: "{UP}", home: "{HOME}", end: "{END}", pageup: "{PGUP}", pagedown: "{PGDN}", f1: "{F1}", f2: "{F2}", f3: "{F3}", f4: "{F4}", f5: "{F5}", f6: "{F6}", f7: "{F7}", f8: "{F8}", f9: "{F9}", f10: "{F10}", f11: "{F11}", f12: "{F12}" };

/** `ctrl+shift+t` → the Windows SendKeys string `^+t`; null when a modifier has no SendKeys form (cmd — there is no Windows key in SendKeys). */
export function windowsSendKeys(spec: string): string | null {
	const k = parseNativeKey(spec);
	if (!k || k.modifiers.includes("cmd")) return null;
	const prefix = k.modifiers.map((m) => (m === "ctrl" ? "^" : m === "alt" ? "%" : "+")).join("");
	return `${prefix}${WIN_KEYS[k.key] ?? k.key}`;
}

/** A launch target is a bundle id when it is reverse-DNS; `open -b` then, else `open -a`. */
export function macOpenArgs(app: string): string[] {
	return /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(app) ? ["-b", app] : ["-a", app];
}

/** PowerShell single-quoted literal. */
export const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

// ── Scripts ───────────────────────────────────────────────────────────────────────────

const JXA_AX = 'ObjC.import("ApplicationServices"); $.AXIsProcessTrusted()';
const JXA_SCREEN = 'ObjC.import("CoreGraphics"); ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]); $.CGPreflightScreenCaptureAccess()';

const JXA_CLICK = `function run(argv) {
  ObjC.import("ApplicationServices");
  const pt = $.CGPointMake(Number(argv[0]), Number(argv[1]));
  const right = argv[2] === "right";
  const clicks = argv[3] === "true" ? 2 : 1;
  const down = right ? $.kCGEventRightMouseDown : $.kCGEventLeftMouseDown;
  const up = right ? $.kCGEventRightMouseUp : $.kCGEventLeftMouseUp;
  const btn = right ? $.kCGMouseButtonRight : $.kCGMouseButtonLeft;
  for (let i = 1; i <= clicks; i++) {
    const d = $.CGEventCreateMouseEvent($(), down, pt, btn);
    $.CGEventSetIntegerValueField(d, $.kCGMouseEventClickState, i);
    $.CGEventPost($.kCGHIDEventTap, d);
    const u = $.CGEventCreateMouseEvent($(), up, pt, btn);
    $.CGEventSetIntegerValueField(u, $.kCGMouseEventClickState, i);
    $.CGEventPost($.kCGHIDEventTap, u);
  }
  return JSON.stringify({ ok: true, data: { done: true } });
}`;

const JXA_SCROLL = `function run(argv) {
  ObjC.import("ApplicationServices");
  const e = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 2, Number(argv[0]), Number(argv[1]));
  $.CGEventPost($.kCGHIDEventTap, e);
  return JSON.stringify({ ok: true, data: { done: true } });
}`;

const JXA_TYPE = `function run(argv) {
  const se = Application("System Events");
  se.keystroke(argv[0]);
  return JSON.stringify({ ok: true, data: { done: true } });
}`;

const JXA_KEY = `function run(argv) {
  const se = Application("System Events");
  const using = argv[2] ? argv[2].split(",") : [];
  const opts = using.length ? { using: using } : {};
  if (argv[1] !== "") se.keyCode(Number(argv[1]), opts); else se.keystroke(argv[0], opts);
  return JSON.stringify({ ok: true, data: { done: true } });
}`;

// Is the focused element a password field? Unknown (an app that does not expose its focus) is NOT secure here.
const JXA_SECURE = `function run() {
  try {
    const se = Application("System Events");
    const p = se.processes.whose({ frontmost: true })[0];
    const f = p.attributes.byName("AXFocusedUIElement").value();
    return JSON.stringify({ secure: f.subrole() === "AXSecureTextField" });
  } catch (e) { return JSON.stringify({ secure: false, unknown: true }); }
}`;

const PS_USER32 = `Add-Type -Namespace N -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, System.UIntPtr e);'`;
const PS_OK = `ConvertTo-Json -Compress @{ ok = $true; data = @{ done = $true } }`;
const psFail = `catch { ConvertTo-Json -Compress @{ ok = $false; code = 'NATIVE_COMMAND_FAILED'; message = $_.Exception.Message } }`;

function psClick(x: number, y: number, right: boolean, double: boolean): string {
	const [d, u] = right ? [8, 16] : [2, 4];
	const once = `[N.U]::mouse_event(${d},0,0,0,[UIntPtr]::Zero); [N.U]::mouse_event(${u},0,0,0,[UIntPtr]::Zero)`;
	return `try { ${PS_USER32}; [N.U]::SetCursorPos(${x},${y}) | Out-Null; ${once}${double ? `; ${once}` : ""}; ${PS_OK} } ${psFail}`;
}
function psScroll(dx: number, dy: number): string {
	const wheel = (flag: string, n: number) => (n === 0 ? "" : `[N.U]::mouse_event(${flag},0,0,${n * 120},[UIntPtr]::Zero); `);
	return `try { ${PS_USER32}; ${wheel("0x0800", dy)}${wheel("0x1000", dx)}${PS_OK} } ${psFail}`;
}
function psType(text: string): string {
	const b64 = Buffer.from(text, "utf8").toString("base64");
	return `try { Add-Type -AssemblyName System.Windows.Forms; $t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); $t = $t -replace '([+^%~(){}\\[\\]])','{$1}' -replace "\`r?\`n",'{ENTER}'; [System.Windows.Forms.SendKeys]::SendWait($t); ${PS_OK} } ${psFail}`;
}
const psKey = (keys: string): string => `try { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psQuote(keys)}); ${PS_OK} } ${psFail}`;
const psLaunch = (app: string): string => `try { Start-Process -FilePath ${psQuote(app)} -ErrorAction Stop; ${PS_OK} } ${psFail}`;
const PS_SECURE = `try { Add-Type -AssemblyName UIAutomationClient; $f = [System.Windows.Automation.AutomationElement]::FocusedElement; ConvertTo-Json -Compress @{ secure = [bool]$f.Current.IsPassword } } catch { ConvertTo-Json -Compress @{ secure = $false; unknown = $true } }`;
const psShot = (file: string): string =>
	`try { Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $b = [System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $bmp.Save(${psQuote(file)}, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose(); ${PS_OK} } ${psFail}`;

// ── The tools ─────────────────────────────────────────────────────────────────────────

const ps = (exec: Exec, script: string, what: string) => safe(exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], NATIVE_READ_TIMEOUT_MS)).then((r) => parseEnvelope<NativeActDone>(r, what));
const jxa = (exec: Exec, script: string, args: string[], what: string) => safe(exec("osascript", ["-l", "JavaScript", "-e", script, ...args], NATIVE_READ_TIMEOUT_MS)).then((r) => parseEnvelope<NativeActDone>(r, what));

/** macOS input needs Accessibility; the report-only check never opens the OS dialog. */
async function macAccessibility(exec: Exec): Promise<NativeReadResult<never> | null> {
	return parseBooleanProbe(await safe(exec("osascript", ["-l", "JavaScript", "-e", JXA_AX]))) === "denied" ? fail("NATIVE_PERMISSIONS_MISSING", `This machine has not granted Accessibility. ${PERMISSION_HINT}`) : null;
}

export async function launchApp(input: { app: string }, deps: ActDeps = {}): Promise<NativeReadResult<NativeActDone>> {
	const halted = guard(deps);
	if (halted) return halted;
	const exec = deps.exec ?? execProbe;
	const platform = deps.platform ?? osPlatform();
	if (platform === "darwin") {
		const r = await safe(exec("open", macOpenArgs(input.app), NATIVE_READ_TIMEOUT_MS));
		if (!r.found || r.code !== 0 || r.timedOut) return /unable to find application|can't find|not found/i.test(r.stderr) ? fail("NATIVE_COMMAND_FAILED", `No app is named ${JSON.stringify(input.app)} on this machine — call native_list_apps, or use its exact name.`) : (({ code, message }) => fail(code, message))(commandFailure(r, `Opening ${input.app}`));
		return DONE;
	}
	if (platform === "win32") return ps(exec, psLaunch(input.app), `Opening ${input.app}`);
	return UNSUPPORTED(platform);
}

export async function click(input: { x: number; y: number; button?: "left" | "right"; double?: boolean }, deps: ActDeps = {}): Promise<NativeReadResult<NativeActDone>> {
	const halted = guard(deps);
	if (halted) return halted;
	const exec = deps.exec ?? execProbe;
	const platform = deps.platform ?? osPlatform();
	if (platform === "darwin") return (await macAccessibility(exec)) ?? jxa(exec, JXA_CLICK, [String(input.x), String(input.y), input.button ?? "left", String(input.double === true)], "Clicking");
	if (platform === "win32") return ps(exec, psClick(input.x, input.y, input.button === "right", input.double === true), "Clicking");
	return UNSUPPORTED(platform);
}

async function focusedIsSecure(exec: Exec, platform: NodeJS.Platform): Promise<boolean> {
	const r = await safe(platform === "darwin" ? exec("osascript", ["-l", "JavaScript", "-e", JXA_SECURE], NATIVE_READ_TIMEOUT_MS) : exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_SECURE], NATIVE_READ_TIMEOUT_MS));
	try {
		return r.code === 0 && (JSON.parse(r.stdout.trim()) as { secure?: unknown }).secure === true;
	} catch {
		return false;
	}
}

export async function typeText(input: { text: string }, deps: ActDeps = {}): Promise<NativeReadResult<NativeActDone>> {
	const halted = guard(deps);
	if (halted) return halted;
	const exec = deps.exec ?? execProbe;
	const platform = deps.platform ?? osPlatform();
	if (platform !== "darwin" && platform !== "win32") return UNSUPPORTED(platform);
	if (platform === "darwin") {
		const denied = await macAccessibility(exec);
		if (denied) return denied;
	}
	if (await focusedIsSecure(exec, platform)) return fail("NATIVE_SECURE_FIELD", "The focused field is a password field. The agent never types credentials — hand the sign-in to the owner (takeover) instead.");
	return platform === "darwin" ? jxa(exec, JXA_TYPE, [input.text], "Typing") : ps(exec, psType(input.text), "Typing");
}

export async function pressKey(input: { key: string }, deps: ActDeps = {}): Promise<NativeReadResult<NativeActDone>> {
	const halted = guard(deps);
	if (halted) return halted;
	const exec = deps.exec ?? execProbe;
	const platform = deps.platform ?? osPlatform();
	const k = parseNativeKey(input.key);
	if (!k) return fail("NATIVE_INVALID_REQUEST", "Not a key.");
	if (platform === "darwin") {
		const denied = await macAccessibility(exec);
		if (denied) return denied;
		const code = MAC_KEY_CODES[k.key];
		return jxa(exec, JXA_KEY, [code === undefined ? k.key : "", code === undefined ? "" : String(code), k.modifiers.map((m) => MAC_MODIFIER[m]).join(",")], "Pressing a key");
	}
	if (platform === "win32") {
		const keys = windowsSendKeys(input.key);
		return keys === null ? fail("NATIVE_INVALID_REQUEST", "Windows has no `cmd` key to press here — use `ctrl` for the shortcut.") : ps(exec, psKey(keys), "Pressing a key");
	}
	return UNSUPPORTED(platform);
}

export async function scroll(input: { dx?: number; dy?: number }, deps: ActDeps = {}): Promise<NativeReadResult<NativeActDone>> {
	const halted = guard(deps);
	if (halted) return halted;
	const exec = deps.exec ?? execProbe;
	const platform = deps.platform ?? osPlatform();
	const dx = input.dx ?? 0;
	const dy = input.dy ?? 0;
	if (platform === "darwin") return (await macAccessibility(exec)) ?? jxa(exec, JXA_SCROLL, [String(dy), String(dx)], "Scrolling");
	if (platform === "win32") return ps(exec, psScroll(dx, dy), "Scrolling");
	return UNSUPPORTED(platform);
}

export function shotDirOf(deps: ActDeps): string {
	return deps.shotDir ?? join(homedir(), ".config", "proagentstore", "native-shots");
}

export async function screenshot(deps: ActDeps = {}): Promise<NativeReadResult<NativeScreenshotData>> {
	const halted = guard(deps);
	if (halted) return halted;
	const exec = deps.exec ?? execProbe;
	const platform = deps.platform ?? osPlatform();
	const files = deps.files ?? realFiles;
	if (platform !== "darwin" && platform !== "win32") return UNSUPPORTED(platform);
	if (platform === "darwin" && parseBooleanProbe(await safe(exec("osascript", ["-l", "JavaScript", "-e", JXA_SCREEN]))) === "denied") {
		// Without it `screencapture` exits 0 and writes the wallpaper — a "successful" shot of nothing.
		return fail("NATIVE_PERMISSIONS_MISSING", `This machine has not granted Screen Recording. ${PERMISSION_HINT}`);
	}
	const dir = shotDirOf(deps);
	try {
		files.mkdir(dir);
	} catch {
		return fail("NATIVE_COMMAND_FAILED", "The runner could not create its private screenshot folder.");
	}
	const file = join(dir, `shot-${(deps.now ?? Date.now)()}.png`);
	const r = platform === "darwin" ? await safe(exec("screencapture", ["-x", "-t", "png", file], NATIVE_READ_TIMEOUT_MS)) : await safe(exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psShot(file)], NATIVE_READ_TIMEOUT_MS));
	if (!r.found || r.code !== 0 || r.timedOut) {
		const f = commandFailure(r, "Taking a screenshot");
		return fail(f.code, f.message);
	}
	const st = files.stat(file);
	if (!st || st.size === 0) return fail("NATIVE_COMMAND_FAILED", "Taking a screenshot produced no image.");
	try {
		files.chmod(file, 0o600);
	} catch {
		// A filesystem without modes (Windows) keeps the folder's own protection.
	}
	const sha256 = createHash("sha256").update(files.read(file)).digest("hex");
	// Keep the newest few; a screen is private and a disk is finite.
	const old = files.list(dir).filter((n) => /^shot-\d+\.png$/.test(n)).sort();
	for (const n of old.slice(0, Math.max(0, old.length - NATIVE_SHOTS_KEPT))) files.remove(join(dir, n));
	return { ok: true, data: { path: file, bytes: st.size, sha256 } };
}

// ── Halt ────────────────────────────────────────────────────────────────────────────

export function halt(deps: ActDeps = {}): NativeReadResult<NativeHaltData> {
	(deps.halt ?? runnerHalt).halted = true;
	return { ok: true, data: { halted: true } };
}
export function resume(deps: ActDeps = {}): NativeReadResult<NativeHaltData> {
	(deps.halt ?? runnerHalt).halted = false;
	return { ok: true, data: { halted: false } };
}
