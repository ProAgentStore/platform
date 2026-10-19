/**
 * The native READ tools (#1057, slice 2): what an agent may look at on the owner's machine — the
 * running apps, an app's accessibility tree, the connected Maestro devices and a device's UI
 * hierarchy — without touching any of it.
 *
 * Rules this module keeps, the same as `preflight.ts`:
 *   - READ-ONLY. Fixed commands; nothing clicks, types, launches, installs or changes a setting.
 *   - NEVER THROWS. Every outcome is a {@link NativeReadResult}: the data, or a stable code with a
 *     sentence the owner can act on — a denied permission, a missing tool, a timeout, no such device.
 *   - BOUNDED. A tree stops at {@link NATIVE_TREE_MAX_NODES} nodes and its depth cap, and says so.
 *   - Parsing is pure and exported, so it is tested on recorded outputs — no live screen needed.
 *
 * The cloud only reaches these routes for a machine its owner opted in (`lib/native/read.ts` in the
 * API); this side does not re-check the opt-in, because the runner has no record of it.
 */
import { platform as osPlatform } from "node:os";
import {
	type NativeApp,
	type NativeErrorCode,
	type NativeListAppsData,
	type NativeMaestroDevicesData,
	type NativeReadResult,
	type NativeTree,
	type NativeUiNode,
	NATIVE_READ_TIMEOUT_MS,
	NATIVE_TREE_DEFAULT_DEPTH,
	NATIVE_TREE_MAX_DEPTH,
	NATIVE_TREE_MAX_NODES,
} from "./contract.js";
import { type Exec, type ExecResult, execProbe, parseAdbDevices, parseBooleanProbe, parseSimctlBooted } from "./preflight.js";

export interface ReadDeps {
	exec?: Exec;
	platform?: NodeJS.Platform;
}

const fail = <T>(code: NativeErrorCode, message: string): NativeReadResult<T> => ({ ok: false, code, message });
const safe = (p: Promise<ExecResult>) => p.catch((): ExecResult => ({ found: false, code: null, stdout: "", stderr: "" }));
/** A tree's output can be large; the default 1MB buffer would fail a busy window. */
const TREE_BUFFER = 8 * 1024 * 1024;
/** Maestro starts a JVM per command, so a hierarchy read gets longer than a desktop read. */
export const MAESTRO_READ_TIMEOUT_MS = 45_000;
/** One element's text is a label, not a document: longer is cut, and marked. */
const TEXT_MAX = 200;

const PERMISSION_HINT = "Grant it to the app that runs `pags up` (e.g. Terminal) in System Settings → Privacy & Security, then restart `pags up`.";

/** A command's failure → the code that names it. Pure. */
export function commandFailure(r: ExecResult, what: string): { code: NativeErrorCode; message: string } {
	if (r.timedOut) return { code: "NATIVE_TIMEOUT", message: `${what} did not answer within its time limit.` };
	// macOS: `osascript` refused Apple events to System Events (-1743), or Accessibility is off (-1719, -25211).
	if (/-1743|not allowed to send Apple events/i.test(r.stderr)) return { code: "NATIVE_PERMISSIONS_MISSING", message: `This machine has not allowed the app that runs \`pags up\` to control System Events (Automation). ${PERMISSION_HINT}` };
	if (/-1719|-25211|assistive access/i.test(r.stderr)) return { code: "NATIVE_PERMISSIONS_MISSING", message: `This machine has not granted Accessibility. ${PERMISSION_HINT}` };
	const said = r.stderr.trim().split("\n").pop() ?? "";
	return { code: "NATIVE_COMMAND_FAILED", message: `${what} failed${said ? `: ${clipText(said)}` : ` (exit ${r.code ?? "unknown"})`}.` };
}

/** Bound one element's text, marking a cut. */
export function clipText(v: string): string {
	return v.length > TEXT_MAX ? `${v.slice(0, TEXT_MAX - 1)}…` : v;
}

/** Parse a script's JSON envelope, or report what it printed instead. Pure. */
export function parseEnvelope<T>(r: ExecResult, what: string): NativeReadResult<T> {
	if (!r.found) return fail("NATIVE_COMMAND_FAILED", `${what}: the command is not available on this machine.`);
	if (r.code !== 0 || r.timedOut) {
		const f = commandFailure(r, what);
		return fail(f.code, f.message);
	}
	try {
		return JSON.parse(r.stdout.trim()) as NativeReadResult<T>;
	} catch {
		return fail("NATIVE_COMMAND_FAILED", `${what} printed something that is not its result.`);
	}
}

// ── Desktop: the running apps ────────────────────────────────────────────────

// NSWorkspace, not System Events: it needs no permission and never opens a consent dialog. Regular
// activation policy (0) is "an app with a Dock icon and windows" — background agents are left out.
const JXA_LIST_APPS = `ObjC.import("AppKit");
const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
const out = [];
for (let i = 0; i < apps.count; i++) {
  const a = apps.objectAtIndex(i);
  if (a.activationPolicy !== 0) continue;
  const bundleId = ObjC.unwrap(a.bundleIdentifier);
  out.push({ name: ObjC.unwrap(a.localizedName) || "", pid: a.processIdentifier, ...(bundleId ? { bundleId } : {}), frontmost: !!a.active });
}
JSON.stringify({ ok: true, data: { apps: out } });`;

const PS_LIST_APPS = `$p = @(Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { [pscustomobject]@{ name = $_.ProcessName; pid = $_.Id; windowTitle = $_.MainWindowTitle } }); ConvertTo-Json -Compress -Depth 4 @{ ok = $true; data = @{ apps = $p } }`;

export async function listApps(deps: ReadDeps = {}): Promise<NativeReadResult<NativeListAppsData>> {
	const exec = deps.exec ?? execProbe;
	const platform = deps.platform ?? osPlatform();
	let r: NativeReadResult<NativeListAppsData>;
	if (platform === "darwin") r = parseEnvelope(await safe(exec("osascript", ["-l", "JavaScript", "-e", JXA_LIST_APPS], NATIVE_READ_TIMEOUT_MS)), "Listing the running apps");
	else if (platform === "win32") r = parseEnvelope(await safe(exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_LIST_APPS], NATIVE_READ_TIMEOUT_MS)), "Listing the running apps");
	else return fail("NATIVE_UNSUPPORTED_OS", `Desktop control is not supported on ${platform} yet (macOS and Windows only).`);
	if (!r.ok) return r;
	// PowerShell's ConvertTo-Json renders a one-element array as an object: normalise, then bound each field.
	const raw = (r.data?.apps ?? []) as NativeApp[] | NativeApp;
	const apps = (Array.isArray(raw) ? raw : [raw]).filter((a) => a && typeof a.name === "string").map((a) => ({
		name: clipText(a.name),
		pid: Number(a.pid),
		...(a.bundleId ? { bundleId: clipText(String(a.bundleId)) } : {}),
		...(a.windowTitle ? { windowTitle: clipText(String(a.windowTitle)) } : {}),
		...(a.frontmost ? { frontmost: true } : {}),
	}));
	return { ok: true, data: { apps } };
}

// ── Desktop: an app's accessibility tree ─────────────────────────────────────

const JXA_AX_TRUSTED = 'ObjC.import("ApplicationServices"); $.AXIsProcessTrusted()';

// Walks the target process's windows through System Events. Every attribute read is guarded: an
// element that refuses one attribute must not lose the whole tree. Bounds are passed in as argv.
const JXA_TREE = `function run(argv) {
  const appName = argv[0] || "";
  const maxDepth = Number(argv[1]);
  const maxNodes = Number(argv[2]);
  const textMax = Number(argv[3]);
  const se = Application("System Events");
  const matches = appName ? se.processes.whose({ name: appName }) : se.processes.whose({ frontmost: true });
  if (matches.length === 0) return JSON.stringify({ ok: false, code: "NATIVE_COMMAND_FAILED", message: appName ? "No running app is named " + JSON.stringify(appName) + " — call native_list_apps for the names." : "No app is in front." });
  const proc = matches[0];
  let count = 0;
  let truncated = false;
  const text = (f) => { try { const v = f(); if (v === null || v === undefined || v === "") return undefined; const s = String(v); return s.length > textMax ? s.slice(0, textMax - 1) + "\\u2026" : s; } catch (e) { return undefined; } };
  function walk(el, depth) {
    if (count >= maxNodes) { truncated = true; return null; }
    count++;
    const node = { role: text(() => el.role()) || "unknown" };
    const name = text(() => el.name()) || text(() => el.title()) || text(() => el.description());
    if (name) node.name = name;
    const value = text(() => el.value());
    if (value && value !== name) node.value = value;
    let kids = [];
    try { kids = el.uiElements(); } catch (e) { kids = []; }
    if (kids.length && depth >= maxDepth) { truncated = true; return node; }
    if (kids.length) {
      node.children = [];
      for (const k of kids) { const c = walk(k, depth + 1); if (!c) break; node.children.push(c); }
    }
    return node;
  }
  const name = text(() => proc.name()) || appName;
  count++;
  const root = { role: "application", name: name, children: [] };
  let wins;
  try { wins = proc.windows(); } catch (e) { return JSON.stringify({ ok: false, code: "NATIVE_PERMISSIONS_MISSING", message: "Reading " + name + "'s windows was refused: " + e }); }
  for (const w of wins) { const c = walk(w, 1); if (!c) break; root.children.push(c); }
  return JSON.stringify({ ok: true, data: { of: name, root: root, nodes: count, truncated: truncated } });
}`;

// Windows UI Automation: the named process's main window, or the foreground window.
const PS_TREE = `param([string]$app, [int]$maxDepth, [int]$maxNodes, [int]$textMax)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace Native -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();'
if ($app) { $p = Get-Process | Where-Object { $_.MainWindowTitle -and ($_.ProcessName -eq $app -or $_.MainWindowTitle -like "*$app*") } | Select-Object -First 1
  if (-not $p) { ConvertTo-Json -Compress @{ ok = $false; code = 'NATIVE_COMMAND_FAILED'; message = "No running app with a window is named '$app' - call native_list_apps for the names." }; exit 0 }
  $h = $p.MainWindowHandle } else { $h = [Native.W]::GetForegroundWindow() }
$rootEl = [System.Windows.Automation.AutomationElement]::FromHandle($h)
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$script:count = 0; $script:truncated = $false
function T([string]$s) { if (-not $s) { return $null }; if ($s.Length -gt $textMax) { return $s.Substring(0, $textMax - 1) + [char]0x2026 }; return $s }
function Walk($el, [int]$depth) {
  if ($script:count -ge $maxNodes) { $script:truncated = $true; return $null }
  $script:count++
  $c = $el.Current
  $node = [ordered]@{ role = ($c.ControlType.ProgrammaticName -replace '^ControlType\\.', '') }
  if ($c.Name) { $node.name = T $c.Name }
  if ($c.AutomationId) { $node.id = T $c.AutomationId }
  $child = $walker.GetFirstChild($el)
  if ($child -and $depth -ge $maxDepth) { $script:truncated = $true; return $node }
  if ($child) { $kids = @(); while ($child) { $k = Walk $child ($depth + 1); if (-not $k) { break }; $kids += $k; $child = $walker.GetNextSibling($child) }; $node.children = $kids }
  return $node
}
$root = Walk $rootEl 0
ConvertTo-Json -Compress -Depth 50 @{ ok = $true; data = @{ of = $rootEl.Current.Name; root = $root; nodes = $script:count; truncated = $script:truncated } }`;

/** The depth the caller asked for, inside the contract's bounds. Pure. */
export function treeDepth(asked: unknown): number {
	const n = typeof asked === "number" && Number.isInteger(asked) ? asked : NATIVE_TREE_DEFAULT_DEPTH;
	return Math.min(Math.max(n, 1), NATIVE_TREE_MAX_DEPTH);
}

export async function accessibilityTree(input: { app?: string; maxDepth?: number }, deps: ReadDeps = {}): Promise<NativeReadResult<NativeTree>> {
	const exec = deps.exec ?? execProbe;
	const platform = deps.platform ?? osPlatform();
	const depth = String(treeDepth(input.maxDepth));
	const app = input.app?.trim() ?? "";
	if (platform === "darwin") {
		// The preflight API only reports state; it never opens the permission dialog.
		const trusted = parseBooleanProbe(await safe(exec("osascript", ["-l", "JavaScript", "-e", JXA_AX_TRUSTED])));
		if (trusted === "denied") return fail("NATIVE_PERMISSIONS_MISSING", `This machine has not granted Accessibility. ${PERMISSION_HINT}`);
		return parseEnvelope(await safe(exec("osascript", ["-l", "JavaScript", "-e", JXA_TREE, app, depth, String(NATIVE_TREE_MAX_NODES), String(TEXT_MAX)], NATIVE_READ_TIMEOUT_MS, TREE_BUFFER)), "Reading the accessibility tree");
	}
	if (platform === "win32") {
		const script = `& { ${PS_TREE} } '${app.replace(/'/g, "''")}' ${depth} ${NATIVE_TREE_MAX_NODES} ${TEXT_MAX}`;
		return parseEnvelope(await safe(exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], NATIVE_READ_TIMEOUT_MS, TREE_BUFFER)), "Reading the accessibility tree");
	}
	return fail("NATIVE_UNSUPPORTED_OS", `Desktop control is not supported on ${platform} yet (macOS and Windows only).`);
}

// ── Maestro: devices and a device's hierarchy ────────────────────────────────

async function maestroState(exec: Exec, platform: NodeJS.Platform): Promise<NativeMaestroDevicesData> {
	const [maestro, adb, simctl] = await Promise.all([
		safe(exec("maestro", ["--version"], NATIVE_READ_TIMEOUT_MS)),
		safe(exec("adb", ["devices", "-l"])),
		platform === "darwin" ? safe(exec("xcrun", ["simctl", "list", "devices", "booted", "--json"])) : Promise.resolve<ExecResult>({ found: false, code: null, stdout: "", stderr: "" }),
	]);
	const devices = [...(adb.found && adb.code === 0 ? parseAdbDevices(adb.stdout) : []), ...(simctl.found && simctl.code === 0 ? parseSimctlBooted(simctl.stdout) : [])];
	return { maestroInstalled: maestro.found && maestro.code === 0, devices };
}

const NOT_INSTALLED = "Maestro is not installed on this machine. The runner never installs it; install it yourself (https://maestro.mobile.dev) if you want phone or emulator automation.";

export async function maestroDevices(deps: ReadDeps = {}): Promise<NativeReadResult<NativeMaestroDevicesData>> {
	const state = await maestroState(deps.exec ?? execProbe, deps.platform ?? osPlatform());
	if (!state.maestroInstalled) return fail("NATIVE_MAESTRO_NOT_INSTALLED", NOT_INSTALLED);
	return { ok: true, data: state };
}

/**
 * Maestro's hierarchy JSON (`{attributes, children}`) → the shared node shape, bounded. Containers
 * that carry no text, id or class are dropped and their children lifted, so a deep layout stack does
 * not spend the depth cap on wrappers nobody can read. Pure.
 */
export function maestroTree(raw: unknown, of: string): NativeTree {
	let count = 0;
	let truncated = false;
	const convert = (n: unknown, depth: number): NativeUiNode[] => {
		const el = (n ?? {}) as { attributes?: Record<string, unknown>; children?: unknown[] };
		const a = el.attributes ?? {};
		const str = (k: string) => (typeof a[k] === "string" && (a[k] as string).trim() ? clipText((a[k] as string).trim()) : undefined);
		const name = str("text") ?? str("accessibilityText") ?? str("hintText");
		const id = str("resource-id");
		const role = str("class");
		const kids = Array.isArray(el.children) ? el.children : [];
		if (!name && !id && !role) return kids.flatMap((k) => convert(k, depth));
		if (count >= NATIVE_TREE_MAX_NODES) {
			truncated = true;
			return [];
		}
		count++;
		const node: NativeUiNode = { role: role ?? "element", ...(name ? { name } : {}), ...(id ? { id } : {}) };
		if (kids.length && depth >= NATIVE_TREE_MAX_DEPTH) {
			truncated = true;
			return [node];
		}
		const children = kids.flatMap((k) => convert(k, depth + 1));
		if (children.length) node.children = children;
		return [node];
	};
	const nodes = convert(raw, 1);
	const root: NativeUiNode | null = nodes.length === 1 ? nodes[0] : nodes.length ? { role: "screen", children: nodes } : null;
	return { of, root, nodes: count, truncated };
}

export async function maestroHierarchy(input: { deviceId: string }, deps: ReadDeps = {}): Promise<NativeReadResult<NativeTree>> {
	const exec = deps.exec ?? execProbe;
	const state = await maestroState(exec, deps.platform ?? osPlatform());
	if (!state.maestroInstalled) return fail("NATIVE_MAESTRO_NOT_INSTALLED", NOT_INSTALLED);
	const device = state.devices.find((d) => d.id === input.deviceId);
	if (!device || (device.state !== "device" && device.state !== "Booted")) {
		const usable = state.devices.filter((d) => d.state === "device" || d.state === "Booted").map((d) => d.id);
		return fail("NATIVE_DEVICE_NOT_FOUND", device ? `${device.name} is ${device.state}, not ready — authorise or boot it.` : `No connected device has the id ${input.deviceId}.${usable.length ? ` Connected: ${usable.join(", ")}.` : " None is connected."}`);
	}
	const r = await safe(exec("maestro", ["--device", input.deviceId, "hierarchy"], MAESTRO_READ_TIMEOUT_MS, TREE_BUFFER));
	if (!r.found || r.code !== 0 || r.timedOut) {
		const f = commandFailure(r, "Maestro's hierarchy read");
		return fail(f.code, f.message);
	}
	// Maestro may print log lines before the JSON document: read from the first brace.
	const start = r.stdout.indexOf("{");
	try {
		return { ok: true, data: maestroTree(JSON.parse(r.stdout.slice(start)), device.name) };
	} catch {
		return fail("NATIVE_COMMAND_FAILED", "Maestro's hierarchy read printed something that is not a hierarchy.");
	}
}
