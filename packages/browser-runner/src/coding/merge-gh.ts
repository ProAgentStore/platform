/** The live `gh` for merge evidence (#1350): the engine's own `gh`, in its working directory, on its credentials. */
import { execFile } from "node:child_process";
import { findRealGh, ghGuardRoot } from "./gh-guard.js";
import type { GhRunner } from "./merge-evidence.js";

const TIMEOUT_MS = 10_000;
const MAX_BUFFER = 2 * 1024 * 1024;

/**
 * Runs the REAL `gh` (never the guard's shim), so a lookup is never refused or recorded as an engine write.
 * Reads only: the callers pass `api` GETs and `repo view`. A missing `gh`, a timeout or a non-zero exit all resolve
 * to a non-zero code; the caller treats that as "unreadable", never as an answer.
 */
export function liveGh(cwd: string, env: NodeJS.ProcessEnv): GhRunner {
	const bin = findRealGh(env.PATH, ghGuardRoot());
	return (args) =>
		new Promise((resolve) => {
			if (!bin) return resolve({ code: -1, stdout: "" });
			execFile(bin, args, { cwd, env, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (err, stdout) => {
				const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : -1) : 0;
				resolve({ code, stdout: String(stdout ?? "") });
			});
		});
}
