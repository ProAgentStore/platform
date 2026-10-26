/**
 * Native desktop / Maestro runtime (`local_native`, #1057) — the wire contract between the API
 * Worker and the runner.
 *
 * This file is copied BYTE-FOR-BYTE between `packages/browser-runner/src/native/contract.ts` and
 * `workers/api/src/lib/native/contract.ts` (the two packages cannot import each other), and
 * `workers/api/src/lib/native/contract.test.ts` fails if they differ. It imports nothing.
 *
 * Slice 1 is the FOUNDATION only: a read-only preflight that reports what this machine could do,
 * plus the run/event shapes the later slices will use. Nothing here drives a screen, a mouse, a
 * keyboard or a Maestro flow yet.
 */

/** The runner route the API calls (over the relay) to probe a machine. Read-only. */
export const NATIVE_PREFLIGHT_PATH = "/native/preflight";

/** The capability a runner advertises once it can answer {@link NATIVE_PREFLIGHT_PATH}. */
export const NATIVE_PREFLIGHT_CAPABILITY = "native.preflight";

/** The two backends of the one `local_native` runtime kind. */
export type NativeBackend = "desktop" | "maestro";
export const NATIVE_BACKENDS: readonly NativeBackend[] = ["desktop", "maestro"];

/** What a later run is asked to do. `readOnly` is the only mode slice 2 will accept. */
export interface NativeRunConfig {
	backend: NativeBackend;
	/** The app to open or read, by its user-visible name (e.g. "WeChat") or bundle/package id. */
	targetApp: string;
	readOnly: boolean;
}

/**
 * The OS permission state for desktop control, as far as the runner can tell without prompting.
 *   granted      — the probe succeeded;
 *   denied       — the OS refused (macOS TCC: Screen Recording or Accessibility not granted);
 *   unsupported  — no desktop control on this OS (e.g. Linux, for now);
 *   unknown      — the probe could not decide (it failed for some other reason).
 */
export type NativePermissionState = "granted" | "denied" | "unsupported" | "unknown";

export interface NativeDevice {
	/** adb serial or simulator UDID. */
	id: string;
	kind: "android" | "ios_simulator";
	/** Human label: the simulator name, or the adb model when it reports one. */
	name: string;
	/** adb `device` / `unauthorized` / `offline`, or the simulator's `Booted`. */
	state: string;
}

export interface NativePreflightResult {
	os: string;
	osVersion: string | null;
	arch: string;
	desktop: {
		/** macOS: both must be granted for screen control. Windows: one UI Automation state. */
		screenRecording: NativePermissionState;
		accessibility: NativePermissionState;
		/** Granted only when every permission desktop control needs is granted. */
		permissionState: NativePermissionState;
	};
	maestro: {
		installed: boolean;
		version: string | null;
		adbInstalled: boolean;
		simctlAvailable: boolean;
		connectedDevices: NativeDevice[];
	};
	/** Every problem found, as stable codes with a sentence for the owner. Empty = nothing missing. */
	errors: Array<{ code: NativeErrorCode; message: string }>;
	/** When the probe ran (epoch ms). */
	checkedAt: number;
}

/** Stable error codes, shared by the API and the runner. */
export type NativeErrorCode =
	| "NATIVE_NOT_ENABLED"
	| "NATIVE_PERMISSIONS_MISSING"
	| "NATIVE_DEVICE_NOT_FOUND"
	| "NATIVE_MAESTRO_NOT_INSTALLED"
	| "NATIVE_UNSUPPORTED_OS"
	| "NATIVE_RUNNER_UNSUPPORTED"
	| "NATIVE_RUNNER_UNREACHABLE"
	// Slice 2 (the read tools):
	| "NATIVE_INVALID_REQUEST"
	| "NATIVE_TIMEOUT"
	| "NATIVE_COMMAND_FAILED"
	// Slice 3 (the act tools):
	| "NATIVE_HALTED"
	| "NATIVE_SECURE_FIELD";

/** Run lifecycle, for slice 2 onward. */
export type NativeRunStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";

/** What a run records about itself. Detail is metadata only — never screen text or credentials. */
export type NativeRunEventType =
	| "run.requested"
	| "run.started"
	| "preflight.checked"
	| "app.launched"
	| "screen.read"
	| "run.paused"
	| "action.performed"
	| "action.refused"
	| "screenshot.taken"
	| "run.halted"
	| "run.resumed"
	| "run.completed"
	| "run.failed"
	| "run.cancelled";

export interface NativeRunEvent {
	seq: number;
	type: NativeRunEventType;
	at: number;
	detail?: Record<string, unknown>;
}

// ── Slice 2: the READ tools ───────────────────────────────────────────────────
//
// Four reads an agent can make of the owner's machine, each behind the per-machine opt-in. None of
// them clicks, types, launches or changes anything. Screenshots are not here yet: an image has no
// way to reach the model or the owner from a tool result today (results are text), so they wait for
// the slice that gives them one.

/** The capability a runner advertises once it serves the read routes below. */
export const NATIVE_READ_CAPABILITY = "native.read";

/** Read tool → the runner route that answers it, and the backend whose opt-in it needs. */
export const NATIVE_READ_ROUTES = {
	native_list_apps: { path: "/native/list-apps", backend: "desktop" },
	native_accessibility_tree: { path: "/native/accessibility-tree", backend: "desktop" },
	native_maestro_devices: { path: "/native/maestro/devices", backend: "maestro" },
	native_maestro_hierarchy: { path: "/native/maestro/hierarchy", backend: "maestro" },
} as const satisfies Record<string, { path: string; backend: NativeBackend }>;
export type NativeReadTool = keyof typeof NATIVE_READ_ROUTES;
export const READ_ONLY_NATIVE_TOOLS = Object.keys(NATIVE_READ_ROUTES) as NativeReadTool[];

/** Bounds on a UI tree, so one screen cannot fill a model's context. */
export const NATIVE_TREE_MAX_DEPTH = 8;
export const NATIVE_TREE_DEFAULT_DEPTH = 5;
export const NATIVE_TREE_MAX_NODES = 200;
/** How long one read may take on the machine before it is answered NATIVE_TIMEOUT. */
export const NATIVE_READ_TIMEOUT_MS = 15_000;

/** A running app with a window the owner could see. */
export interface NativeApp {
	name: string;
	pid: number;
	/** macOS bundle id, when the OS reports one. */
	bundleId?: string;
	/** Windows: the main window's title. */
	windowTitle?: string;
	frontmost?: boolean;
}

/** One element of an app's or a device's UI — the same shape for desktop and Maestro. */
export interface NativeUiNode {
	/** AX role (macOS), control type (Windows), or the element's class (Maestro). */
	role: string;
	name?: string;
	value?: string;
	/** A stable id where the platform has one (Windows AutomationId, Android resource-id). */
	id?: string;
	children?: NativeUiNode[];
}

export interface NativeAccessibilityTreeRequest {
	/** The app, by its visible name. Omit for the frontmost app. */
	app?: string;
	/** How many levels below the window (default {@link NATIVE_TREE_DEFAULT_DEPTH}, at most {@link NATIVE_TREE_MAX_DEPTH}). */
	maxDepth?: number;
}
export interface NativeMaestroHierarchyRequest {
	/** The device id from native_maestro_devices (adb serial or simulator UDID). */
	deviceId: string;
}

/** Every read answers in one envelope: the data, or a stable code with a sentence. */
export type NativeReadResult<T> = { ok: true; data: T } | { ok: false; code: NativeErrorCode; message: string };

export interface NativeTree {
	/** What the tree is of: the app's name, or the device's id. */
	of: string;
	root: NativeUiNode | null;
	nodes: number;
	/** True when the node or depth cap cut the tree short. */
	truncated: boolean;
}

export interface NativeListAppsData {
	apps: NativeApp[];
}
export interface NativeMaestroDevicesData {
	maestroInstalled: boolean;
	devices: NativeDevice[];
}

/** Validate a read request's input; a message when it is not one. Shared so both sides refuse alike. */
export function nativeReadInputError(tool: NativeReadTool, input: Record<string, unknown>): string | null {
	if (tool === "native_accessibility_tree") {
		if (input.app !== undefined && (typeof input.app !== "string" || !input.app.trim() || input.app.length > 120)) return "`app` must be an app's visible name (1–120 characters), or omitted for the frontmost app.";
		if (input.maxDepth !== undefined && (typeof input.maxDepth !== "number" || !Number.isInteger(input.maxDepth) || input.maxDepth < 1)) return `\`maxDepth\` must be a whole number from 1 to ${NATIVE_TREE_MAX_DEPTH}.`;
	}
	if (tool === "native_maestro_hierarchy") {
		if (typeof input.deviceId !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(input.deviceId)) return "`deviceId` must be a device id from native_maestro_devices.";
	}
	return null;
}

// ── Slice 3: the ACT tools ────────────────────────────────────────────────────
//
// Launch an app, click, type, press a key, scroll, take a screenshot — and halt. Each is behind the same
// per-machine opt-in as the reads, and the three that can DO something consequential (click, type, key)
// also wait for the owner's approval on every call (the registry's per-call approval, `ToolDef.approval`).
// Nothing here logs what was typed or what the screen showed: the audit records the tool, the machine,
// counts and codes. A screenshot is saved on the machine and NOT sent anywhere — pixels can hold anything.

/** The capability a runner advertises once it serves the act routes below. */
export const NATIVE_ACT_CAPABILITY = "native.act";

/** Act tool → the runner route, its backend, and whether every call waits for the owner. */
export const NATIVE_ACT_ROUTES = {
	native_launch_app: { path: "/native/launch-app", backend: "desktop", approval: false },
	native_click: { path: "/native/click", backend: "desktop", approval: true },
	native_type: { path: "/native/type", backend: "desktop", approval: true },
	native_key: { path: "/native/key", backend: "desktop", approval: true },
	native_scroll: { path: "/native/scroll", backend: "desktop", approval: false },
	native_screenshot: { path: "/native/screenshot", backend: "desktop", approval: false },
} as const satisfies Record<string, { path: string; backend: NativeBackend; approval: boolean }>;
export type NativeActTool = keyof typeof NATIVE_ACT_ROUTES;
export const NATIVE_ACT_TOOLS = Object.keys(NATIVE_ACT_ROUTES) as NativeActTool[];

/** Halt stops every act tool on the machine until the OWNER resumes it; the agent can halt, never resume. */
export const NATIVE_HALT_PATH = "/native/halt";
export const NATIVE_RESUME_PATH = "/native/resume";

/** Bounds, so one call cannot be a flood or a screen-sized bet. */
export const NATIVE_COORD_MAX = 20_000;
export const NATIVE_TYPE_MAX_CHARS = 2_000;
export const NATIVE_SCROLL_MAX = 100;
export const NATIVE_WHY_MAX_CHARS = 300;
/** Screenshots kept on the machine; older ones are deleted as new ones are taken. */
export const NATIVE_SHOTS_KEPT = 20;

export const NATIVE_MODIFIERS = ["cmd", "ctrl", "alt", "shift"] as const;
export type NativeModifier = (typeof NATIVE_MODIFIERS)[number];
/** Named keys; a single letter or digit is also a key. */
export const NATIVE_KEY_NAMES = ["return", "tab", "escape", "space", "delete", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12"] as const;

/** `cmd+shift+4`, `return`, `a`: the modifiers (in any order, no repeats) and one key. Null when it is not one. */
export function parseNativeKey(spec: unknown): { modifiers: NativeModifier[]; key: string } | null {
	if (typeof spec !== "string") return null;
	const parts = spec.trim().toLowerCase().split("+");
	const key = parts.pop() ?? "";
	const mods = parts as NativeModifier[];
	if (new Set(mods).size !== mods.length || !mods.every((m) => (NATIVE_MODIFIERS as readonly string[]).includes(m))) return null;
	if (!((NATIVE_KEY_NAMES as readonly string[]).includes(key) || /^[a-z0-9]$/.test(key))) return null;
	return { modifiers: mods, key };
}

export interface NativeActDone {
	done: true;
}
export interface NativeScreenshotData {
	/** Where the image is, ON THE MACHINE. The image itself is never sent to the model or the log. */
	path: string;
	bytes: number;
	sha256: string;
}
export interface NativeHaltData {
	halted: boolean;
}

/** An app's visible name or bundle id: letters, digits, spaces and . _ + & ( ) ' - — no path, no shell, no control characters. */
export const NATIVE_APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._+&()'-]{0,119}$/u;

const int = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** Validate an act request's input; a message when it is not one. Shared so both sides refuse alike. */
export function nativeActInputError(tool: NativeActTool, input: Record<string, unknown>): string | null {
	if (tool === "native_launch_app") {
		if (typeof input.app !== "string" || !NATIVE_APP_NAME.test(input.app)) return "`app` must be an app's visible name or bundle id (letters, digits, spaces and . _ + & ( ) ' -, at most 120 characters) — never a path.";
	}
	if (tool === "native_click") {
		if (!int(input.x, 0, NATIVE_COORD_MAX) || !int(input.y, 0, NATIVE_COORD_MAX)) return `\`x\` and \`y\` must be whole screen coordinates from 0 to ${NATIVE_COORD_MAX}.`;
		if (input.button !== undefined && input.button !== "left" && input.button !== "right") return "`button` must be \"left\" or \"right\".";
		if (input.double !== undefined && typeof input.double !== "boolean") return "`double` must be true or false.";
	}
	if (tool === "native_type") {
		if (typeof input.text !== "string" || input.text.length < 1 || input.text.length > NATIVE_TYPE_MAX_CHARS) return `\`text\` must be 1–${NATIVE_TYPE_MAX_CHARS} characters.`;
	}
	if (tool === "native_key") {
		if (!parseNativeKey(input.key)) return "`key` must be a key with optional modifiers, e.g. `return`, `tab`, `cmd+a`, `ctrl+shift+t` (modifiers: cmd, ctrl, alt, shift; one key: a-z, 0-9, return, tab, escape, space, delete, arrows, home, end, pageup, pagedown, f1-f12).";
	}
	if (tool === "native_scroll") {
		const dx = input.dx ?? 0;
		const dy = input.dy ?? 0;
		if (!int(dx, -NATIVE_SCROLL_MAX, NATIVE_SCROLL_MAX) || !int(dy, -NATIVE_SCROLL_MAX, NATIVE_SCROLL_MAX) || (dx === 0 && dy === 0)) return `\`dy\` (down is negative) and/or \`dx\` must be whole numbers of lines from -${NATIVE_SCROLL_MAX} to ${NATIVE_SCROLL_MAX}, not both zero.`;
	}
	if (input.why !== undefined && (typeof input.why !== "string" || input.why.length > NATIVE_WHY_MAX_CHARS)) return `\`why\` must be text of at most ${NATIVE_WHY_MAX_CHARS} characters.`;
	return null;
}
