import { execFileSync } from "node:child_process";

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

export interface TmuxSessionInfo {
	name: string;
	windows: number;
	attached: boolean;
	/** The command running in the active pane (e.g. "claude", "node", "zsh") — the cheapest "what is this?" signal. */
	activeCommand: string;
	/** Title of the active window. */
	activeWindow: string;
	/** Unix seconds the session was created (as a string — tmux formats it). */
	created: string;
}

/**
 * Rich listing of every live session with the signal a UI/agent needs to tell them
 * apart: window count, attach state, and what's running in the active pane. Returns
 * an empty array when no tmux server is running (never throws).
 */
export function listSessionsDetailed(): TmuxSessionInfo[] {
	try {
		// Tab-separated so a session name containing spaces can't split a field.
		const fmt = "#{session_name}\t#{session_windows}\t#{session_attached}\t#{pane_current_command}\t#{window_name}\t#{session_created}";
		const out = execFileSync("tmux", ["list-sessions", "-F", fmt], { encoding: "utf8", stdio: "pipe" });
		return out
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.map((line) => {
				const [name, windows, attached, activeCommand, activeWindow, created] = line.split("\t");
				return {
					name: name ?? "",
					windows: Number(windows) || 0,
					attached: attached === "1",
					activeCommand: activeCommand ?? "",
					activeWindow: activeWindow ?? "",
					created: created ?? "",
				};
			})
			.filter((s) => s.name);
	} catch {
		return [];
	}
}

/**
 * Type a command line into a session's active pane and press Enter — the convenience
 * wrapper over sendText + sendKey for "run this shell/git command". The text is sent
 * literally (`-l`), so it is never shell-interpreted by tmux; the receiving pane's
 * shell/CLI runs it exactly as a human would have typed it.
 */
export function runCommand(target: string, command: string): void {
	sendText(target, command);
	sendKey(target, "Enter");
}

/**
 * Settle heuristic constants — mirror the Coder headless.ts values (1.5s quiet = idle;
 * 8s absolute backstop for a slow-booting CLI). The short backstop covers send/run where
 * the pane is already live; the long one is for new-session launches where the CLI may
 * take several seconds to paint its first prompt.
 */
export const SETTLE_QUIET_MS = 750;
export const SETTLE_POLL_MS = 120;
export const SETTLE_TIMEOUT_MS = 8_000;

/**
 * Poll-capture a pane until its content is unchanged for `quietMs` ms, or until
 * `timeoutMs` elapses (backstop so a continuously-animated pane can't hang the tool).
 *
 * Returns the final pane content. This is the write-side analogue of the read-side labels
 * in `terminal-label.ts`: before returning "Sent", we verify the pane has reacted.
 *
 * Pure behaviour — no side effects beyond calling `capturePane`; tested in unit tests
 * without a real tmux by passing a custom `captureFn`.
 */
export async function waitForPaneSettle(
	target: string,
	opts: {
		quietMs?: number;
		timeoutMs?: number;
		pollMs?: number;
		/** Override for testing — avoids needing a live tmux session. */
		captureFn?: (t: string) => string;
	} = {},
): Promise<string> {
	const quietMs = opts.quietMs ?? SETTLE_QUIET_MS;
	const timeoutMs = opts.timeoutMs ?? SETTLE_TIMEOUT_MS;
	const pollMs = opts.pollMs ?? SETTLE_POLL_MS;
	const capture = opts.captureFn ?? ((t: string) => capturePane(t));
	const deadline = Date.now() + timeoutMs;
	let last = capture(target);
	let lastChangedAt = Date.now();
	while (true) {
		await new Promise<void>((r) => setTimeout(r, pollMs));
		const now = Date.now();
		const current = capture(target);
		if (current !== last) {
			last = current;
			lastChangedAt = now;
		}
		const quietFor = now - lastChangedAt;
		if (quietFor >= quietMs || now >= deadline) {
			return last;
		}
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
