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
	| "NATIVE_RUNNER_UNREACHABLE";

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
