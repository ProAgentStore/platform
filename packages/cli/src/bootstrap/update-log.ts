/**
 * The step-by-step update log (#1151): `<config>/update.log`, one timestamped line per step of a self-update —
 * install, the old process leaving, the respawn, the new version starting, its first registration — with every
 * error and exit code.
 *
 * On 2026-10-17 three machines reported `installing` and were never heard from again, and nothing on any of them
 * said which step had died: the platform saw only the last heartbeat, and the terminal had been cleared. This file
 * is what the next one leaves behind. The first registration after a restart uploads its tail ({@link updateLogTail})
 * onto the machine's update record.
 *
 * Node builtins ONLY — and `crash-reports.ts` for the shared redactor, which is held to builtins itself: the
 * bootstrap stub writes to it too. Writing never throws — a log must not stop an update.
 */
import { maskSecrets } from "../crash-reports.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Past this the file is cut back to its newest half, so it can never grow without bound. */
const MAX_BYTES = 256 * 1024;
/** What one upload carries: the newest lines, at most this many characters. */
export const UPDATE_LOG_UPLOAD_CHARS = 4000;

export function updateLogPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.PAGS_UPDATE_LOG?.trim() || join(env.PAGS_CONFIG_DIR?.trim() || join(homedir(), ".config", "proagentstore"), "update.log");
}

/** Append one step. Never throws. */
export function logUpdateStep(step: string, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): void {
	const path = updateLogPath(env);
	try {
		mkdirSync(dirname(path), { recursive: true });
		if (existsSync(path) && statSync(path).size > MAX_BYTES) {
			const text = readFileSync(path, "utf8");
			writeFileSync(path, text.slice(text.indexOf("\n", text.length / 2) + 1));
		}
		appendFileSync(path, `${now.toISOString()} [${process.pid}] ${step.replace(/\s*\n\s*/g, " | ")}\n`);
	} catch {
		// the log is evidence, never a reason to fail
	}
}

/** The newest whole lines of the log, at most {@link UPDATE_LOG_UPLOAD_CHARS} characters — null when there is none. */
export function updateLogTail(env: NodeJS.ProcessEnv = process.env, maxChars = UPDATE_LOG_UPLOAD_CHARS): string | null {
	try {
		// Through the one redactor everything cloudward passes (#1166): a step can quote a command line or an error.
		const text = maskSecrets(readFileSync(updateLogPath(env), "utf8").trimEnd());
		if (!text) return null;
		if (text.length <= maxChars) return text;
		const cut = text.slice(-maxChars);
		return cut.slice(cut.indexOf("\n") + 1);
	} catch {
		return null;
	}
}

/**
 * The log's upload for one start: its tail rides this process's reports until the platform first answers one, then
 * stops — the steps of the last update, or of a restart that never came up, land on the machine's record once.
 */
export function updateLogUpload(version: string, env: NodeJS.ProcessEnv = process.env) {
	let pending = updateLogTail(env);
	return {
		/** The field for a status report while the upload is pending. */
		body: (): { updateLog?: string } => (pending ? { updateLog: pending } : {}),
		/** The platform answered a report of this start. */
		answered: () => {
			if (pending === null) return;
			pending = null;
			logUpdateStep(`registered: ${version} answered by the platform`, env);
		},
	};
}
