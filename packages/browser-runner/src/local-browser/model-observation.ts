import { closeSync, constants, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** Read only the exact CLI thread's metadata, never publish its prompts, tool output or path. */
export class CodexModelObserver {
	private threadId: string | null = null;
	private observed = false;
	private readonly canonicalCwd: string | null;
	constructor(private readonly codexHome: string, cwd: string, private readonly startedAt: number) {
		this.canonicalCwd = this.directoryIdentity(cwd);
	}

	private directoryIdentity(path: unknown): string | null {
		if (typeof path !== "string" || path.length > 4096 || !isAbsolute(path)) return null;
		try { return statSync(path).isDirectory() ? realpathSync(path) : null; } catch { return null; }
	}

	private matchesCwd(path: unknown): boolean {
		return this.canonicalCwd !== null && this.directoryIdentity(path) === this.canonicalCwd;
	}

	acceptLine(line: string): void {
		if (this.threadId || line.length > 2000) return;
		try {
			const event = JSON.parse(line);
			if (event.type === "thread.started" && typeof event.thread_id === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(event.thread_id)) this.threadId = event.thread_id;
		} catch { /* Non-JSON output is never treated as identity. */ }
	}

	read(): Record<string, string> | null {
		if (!this.threadId || this.observed || !this.canonicalCwd) return null;
		// Rollout folders can use the host's local date. Bound lookup to the launch date +/- a day.
		for (const offset of [-1, 0, 1]) {
			const date = new Date(this.startedAt + offset * 86_400_000).toISOString().slice(0, 10).replaceAll("-", "/");
			const directory = join(this.codexHome, "sessions", date);
			try {
				if (realpathSync(directory) !== resolve(directory)) continue;
				const matches = readdirSync(directory).filter((name) => /^rollout-/.test(name) && name.endsWith(`-${this.threadId}.jsonl`));
				if (matches.length !== 1) continue;
				const path = join(directory, matches[0]);
				if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) continue;
				const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
				let text: string;
				try {
					const buffer = Buffer.alloc(4 * 1024 * 1024);
					text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
				} finally { closeSync(fd); }
				let bound = false;
				for (const line of text.split("\n")) {
					let event: { type?: string; payload?: Record<string, unknown> };
					try { event = JSON.parse(line); } catch { continue; }
					const payload = event.payload ?? {};
					if (event.type === "session_meta") bound = payload.id === this.threadId && this.matchesCwd(payload.cwd);
					if (!bound || event.type !== "turn_context" || !this.matchesCwd(payload.cwd) || typeof payload.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(payload.model)) continue;
					this.observed = true;
					return { observedModel: payload.model, ...(typeof payload.effort === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(payload.effort) ? { observedReasoningEffort: payload.effort } : {}), modelVerification: "local_cli_metadata", source: "codex_rollout_turn_context" };
				}
			} catch { /* Missing, moved or inaccessible metadata leaves identity explicitly unverified. */ }
		}
		return null;
	}
}
