/**
 * Checks that must pass BEFORE an update is fetched or swapped in (#1320).
 *
 * The payload cache already installs side by side and renames into place, and a new version that never
 * registers is rolled back (trial.ts). What was missing was refusing to start an install that cannot
 * finish: a nearly-full disk or a cache folder the user cannot write turns a routine update into a
 * half-written scratch folder, and a Node too old to run the CLI turns it into a version that crashes on
 * import. Each is a failure said out loud, with the machine left exactly as it was.
 *
 * Node builtins ONLY, like payload.ts: the stub imports this.
 */
import { mkdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** An install unpacks a few hundred MB of dependencies; below this it would fail part-way. */
export const MIN_FREE_BYTES = 400 * 1024 * 1024;
/** The oldest Node the CLI is run on. */
export const MIN_NODE_MAJOR = 18;

export interface PreflightDeps {
	/** Free bytes on the volume holding `dir` (or its nearest existing parent); null when it cannot be read. */
	freeBytes: (dir: string) => number | null;
	/** Create `dir` and prove a file can be written in it. */
	writable: (dir: string) => boolean;
	nodeVersion: string;
}

export function realPreflightDeps(): PreflightDeps {
	return {
		freeBytes: (dir) => {
			let d = dir;
			for (let i = 0; i < 8; i++) {
				try {
					const s = statfsSync(d);
					return s.bavail * s.bsize;
				} catch {
					const up = dirname(d);
					if (up === d) return null;
					d = up;
				}
			}
			return null;
		},
		writable: (dir) => {
			try {
				mkdirSync(dir, { recursive: true });
				const probe = join(dir, `.preflight-${process.pid}`);
				writeFileSync(probe, "");
				rmSync(probe, { force: true });
				return true;
			} catch {
				return false;
			}
		},
		nodeVersion: process.versions.node,
	};
}

export type PreflightResult = { ok: true } | { ok: false; reason: string };

/** Run every check and say the first that fails. Nothing is created beyond a one-byte probe file that is removed. */
export function preflightInstall(root: string, deps: PreflightDeps = realPreflightDeps()): PreflightResult {
	const major = Number.parseInt(deps.nodeVersion, 10);
	if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
		return { ok: false, reason: `Node ${deps.nodeVersion} is too old to run this CLI (needs ${MIN_NODE_MAJOR} or later); update Node first` };
	}
	if (!deps.writable(root)) return { ok: false, reason: `the update folder is not writable by this user (${root}); fix its permissions` };
	const free = deps.freeBytes(root);
	if (free !== null && free < MIN_FREE_BYTES) {
		return { ok: false, reason: `only ${Math.floor(free / 1024 / 1024)} MB free where the update installs; it needs ${Math.floor(MIN_FREE_BYTES / 1024 / 1024)} MB. Free some disk space` };
	}
	return { ok: true };
}
