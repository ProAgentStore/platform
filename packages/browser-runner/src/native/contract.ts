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
	| "NATIVE_COMMAND_FAILED";

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
