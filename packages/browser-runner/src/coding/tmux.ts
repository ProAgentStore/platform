import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Low-level tmux primitives for the coding runtime.
 *
 * Ported from the AgentCoder `bridge/src/tmux.ts`, stripped of the Firebase /
 * logger coupling. These are the "hands" the coding runtime uses to drive a
 * local AI coding CLI (Claude / Gemini / Codex) running inside a tmux pane —
 * the tmux analogue of Playwright's page actions in the browser runtime.
 *
 * Everything goes through `execFileSync` with an args array so user/agent text
 * is never shell-interpolated.
 */

/** Run tmux with an args array. Throws on non-zero exit. */
export function tmuxExec(args: string[], timeoutMs = 5000): string {
	return execFileSync("tmux", args, { encoding: "utf8", timeout: timeoutMs });
}

/**
 * The pane target for a session. We address the session by name so tmux routes
 * to its active pane — robust against user `base-index`/`pane-base-index` config
 * (a hardcoded `:0.0` breaks when the user sets 1-based indices).
 */
export function paneTarget(sessionName: string): string {
	return sessionName;
}

/** Send a named key (Enter, Escape, C-c, …) to a pane. */
export function sendKey(target: string, key: string): void {
	tmuxExec(["send-keys", "-t", target, key]);
}

/** Send literal text to a pane (no shell interpolation, no key interpretation). */
export function sendText(target: string, text: string): void {
	tmuxExec(["send-keys", "-t", target, "-l", text]);
}

/** True if a tmux session with this name exists. */
export function sessionExists(sessionName: string): boolean {
	try {
		execFileSync("tmux", ["has-session", "-t", sessionName], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

/** Create a detached session running an optional command in `workDir`. */
export function createSession(sessionName: string, workDir: string, command?: string): void {
	const args = ["new-session", "-d", "-s", sessionName, "-c", workDir, "-x", "200", "-y", "50"];
	if (command) args.push(command);
	execFileSync("tmux", args, { stdio: "ignore" });
}

/** Kill a session. Returns false if it did not exist. */
export function killSession(sessionName: string): boolean {
	try {
		execFileSync("tmux", ["kill-session", "-t", sessionName], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

/** List names of all live sessions. */
export function listSessions(): string[] {
	try {
		const out = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
			encoding: "utf8",
			stdio: "pipe",
		});
		return out.split("\n").map((s) => s.trim()).filter(Boolean);
	} catch {
		return [];
	}
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape codes from tmux output.
const ANSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;

/** Strip ANSI escape codes. */
export function stripAnsi(s: string): string {
	return s.replace(ANSI, "");
}

/**
 * Capture the current pane content. `-J` joins wrapped lines so long lines stay
 * intact; `-S -lines` includes scrollback. Returns ANSI-stripped, trimmed text.
 */
export function capturePane(target: string, lines = 200): string {
	const captured = tmuxExec(["capture-pane", "-p", "-t", target, "-S", `-${lines}`, "-J"]);
	return stripAnsi(captured).trim();
}

/** A safe, collision-resistant tmux session name derived from an arbitrary label. */
export function sanitizeSessionName(label: string): string {
	return label.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "session";
}

/**
 * Ensure a repo is present at `dir`, cloning it from `cloneUrl` if not. Idempotent
 * — an existing checkout is left alone (no clobber). For private repos a GitHub
 * App installation token is injected as `x-access-token` into an https URL. The
 * coding CLI then runs in this directory.
 *
 * Returns the absolute working directory. Throws on clone failure so the caller
 * can surface it (a session can't start without its repo).
 */
export function ensureRepo(dir: string, opts: { cloneUrl?: string; branch?: string; token?: string } = {}): string {
	// A real checkout (has .git) is reused as-is.
	if (existsSync(join(dir, ".git"))) return dir;
	if (!opts.cloneUrl) {
		// No source to clone from — make the directory so tmux can cd into it.
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		return dir;
	}
	// The dir exists but has no `.git`. It could be a half-cloned/empty managed dir
	// (safe to clear) OR a real user directory the caller passed as an explicit workDir
	// (deleting it = data loss). NEVER recursively delete a non-empty non-git dir — refuse
	// instead, so a mis-wired workDir+cloneUrl can't nuke a user's files. An empty dir is
	// fine to remove (git clone needs an empty/absent target).
	if (existsSync(dir)) {
		const entries = readdirSync(dir);
		if (entries.length > 0) {
			throw new Error(`Refusing to clone into non-empty directory "${dir}" (no .git found) — move it aside or point at an empty path.`);
		}
		rmSync(dir, { recursive: true, force: true });
	}
	let url = opts.cloneUrl;
	if (opts.token && /^https:\/\//.test(url)) {
		url = url.replace(/^https:\/\//, `https://x-access-token:${opts.token}@`);
	}
	const args = ["clone", "--depth", "1"];
	if (opts.branch) args.push("--branch", opts.branch);
	args.push(url, dir);
	execFileSync("git", args, { stdio: "pipe", timeout: 180_000 });
	return dir;
}
