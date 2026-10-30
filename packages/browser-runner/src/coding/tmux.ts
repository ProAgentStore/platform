import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { RunnerInputError } from "../errors.js";

/**
 * Low-level tmux primitives for the coding runtime.
 *
 * Ported from the AgentCoder `bridge/src/tmux.ts`, stripped of the Firebase /
 * logger coupling. These are the "hands" the coding runtime uses to drive a
 * local AI coding CLI (Claude / Gemini / Codex) running inside a tmux pane —
 * the tmux analogue of Playwright's page actions in the browser runtime.
 *
 * Everything goes through `execFileSync` with an args array so user/agent text
 * is never shell-interpolated, and typed text goes over stdin (`typeLiteral`) so it is
 * not in any process's argv either (#1196).
 */

/**
 * The marker the cloud matches on (#461). A runner without tmux used to answer `spawnSync tmux
 * ENOENT` as a bare 500, which the sign-in relay surfaced as "Internal server error" with nothing
 * to act on. It is now a 424 that names the missing prerequisite and how to install it.
 */
export const TMUX_MISSING = "tmux_not_installed";

/** How to install tmux on this machine, by platform; the cloud shows this verbatim. */
export function tmuxInstallHint(platform: string = process.platform): string {
	if (platform === "darwin") return "Install it with `brew install tmux`";
	if (platform === "linux") return "Install it with your package manager (`sudo apt install tmux`, `sudo dnf install tmux` or `sudo pacman -S tmux`)";
	return "tmux is not supported natively on this platform — run the runner inside WSL or another Linux/macOS environment";
}

/** Raised when a terminal operation needs tmux and it is not on the runner's PATH. */
export class TmuxMissingError extends RunnerInputError {
	constructor(platform: string = process.platform) {
		super(`${TMUX_MISSING}: tmux is not installed on this runner. ${tmuxInstallHint(platform)}, then try again.`, 424);
		this.name = "TmuxMissingError";
	}
}

function isMissingBinary(e: unknown): boolean {
	return (e as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Run a tmux invocation, turning "tmux is not installed" into {@link TmuxMissingError}. */
function viaTmux<T>(run: () => T): T {
	try {
		return run();
	} catch (e) {
		if (isMissingBinary(e)) throw new TmuxMissingError();
		throw e;
	}
}

/** True when a `tmux` binary can be started. */
export function tmuxAvailable(): boolean {
	try {
		execFileSync("tmux", ["-V"], { stdio: "ignore" });
		return true;
	} catch (e) {
		// A tmux that exists but fails `-V` is still installed; only a missing binary is "absent".
		return !isMissingBinary(e);
	}
}

/** Run tmux with an args array. Throws on non-zero exit. */
export function tmuxExec(args: string[], timeoutMs = 5000): string {
	return viaTmux(() => execFileSync("tmux", args, { encoding: "utf8", timeout: timeoutMs }));
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

/**
 * Type literal text into a pane WITHOUT the text in any process's argv (#1196).
 *
 * `send-keys -l <text>` left the text in a child's argv, readable through `ps` or `/proc/<pid>/cmdline`. Here it travels on
 * STDIN to `load-buffer`, then `paste-buffer -d -r` types it: `-d` deletes the buffer as it pastes, `-r` keeps line feeds as
 * line feeds (what `send-keys -l` typed), and no `-p` means no bracketed-paste markers. A paste that fails still has its
 * buffer deleted. No tmux error here quotes the text: it is not in the argv they quote.
 *
 * RESIDUAL TRUST BOUNDARY: between `load-buffer` and `paste-buffer` (milliseconds) the text is a named tmux buffer that any
 * process of the same user able to reach the tmux server socket can read with `tmux show-buffer`; afterwards it is in the
 * pane and its scrollback, and in the program the pane runs. This removes the process table from the exposure; it does not
 * make the exposure zero.
 */
export function typeLiteral(target: string, text: string): void {
	if (!text) return;
	const buffer = `pags-type-${randomUUID()}`;
	const opts = (input: string) => ({ input, encoding: "utf8" as const, timeout: 5000, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] });
	try {
		viaTmux(() => execFileSync("tmux", ["load-buffer", "-b", buffer, "-"], opts(text)));
		viaTmux(() => execFileSync("tmux", ["paste-buffer", "-d", "-r", "-b", buffer, "-t", target], opts("")));
	} finally {
		// `-d` deleted it on a paste that ran; this is the paste that did not.
		try {
			execFileSync("tmux", ["delete-buffer", "-b", buffer], opts(""));
		} catch {
			// Already gone — the normal case.
		}
	}
}

/** Send literal text to a pane (no shell interpolation, no key interpretation), over stdin (#1196). An empty string is a no-op. */
export function sendText(target: string, text: string): void {
	typeLiteral(target, text);
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
	viaTmux(() => execFileSync("tmux", args, { stdio: "ignore" }));
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
/**
 * The field separator in `-F`'s output. NOT a tab (#1254): tmux ≥3.6 sanitizes control characters
 * out of format output, rewriting every tab to `_` — so a tab-separated format string silently
 * collapses to one field, and every session disappeared from this listing on that tmux version.
 * `|` is printable, so it survives; verified against a real session list, not assumed.
 */
const FIELD_SEP = "|";

export function listSessionsDetailed(): TmuxSessionInfo[] {
	try {
		// `|`-separated — see FIELD_SEP's comment for why not tab.
		const fmt = `#{session_name}${FIELD_SEP}#{session_windows}${FIELD_SEP}#{session_attached}${FIELD_SEP}#{pane_current_command}${FIELD_SEP}#{window_name}${FIELD_SEP}#{session_created}`;
		const out = execFileSync("tmux", ["list-sessions", "-F", fmt], { encoding: "utf8", stdio: "pipe" });
		return out
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.map((line) => {
				const [name, windows, attached, activeCommand, activeWindow, created] = line.split(FIELD_SEP);
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

// ── Marker-delimited command runs (#1406) ───────────────────────────────────────────────────
//
// `tmux_run_command` used to return the whole visible pane — every earlier command and its
// output, with the new output tacked on the bottom — because `capturePane` has no idea where
// "before" ends and "this command" begins. The fix is the sentinel trick the issue itself names
// ("parse sentinels like `echo DONE`"), done ONCE here instead of by every caller: wrap the
// command in a unique start marker (so we know exactly where its output starts) and an end
// marker carrying `$?` (so "finished" is an observed fact, not a quiescence guess, and the exit
// code comes for free).

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RunMarkers {
	start: string;
	end: string;
}

/** A fresh, effectively-unique marker pair for one `tmux_run_command` call. */
export function makeRunMarkers(): RunMarkers {
	const id = randomUUID().replace(/-/g, "");
	return { start: `__pags_run_start_${id}__`, end: `__pags_run_end_${id}__` };
}

/**
 * The shell line that actually runs `command`, bracketed by markers that print on their OWN
 * line — the start one right before it, the end one right after, carrying its exit code.
 * `command` may itself be `a; b && c`, several statements, etc.; `$?` after it is always the
 * LAST one's exit status, same as it would be for a human typing the same line.
 */
export function wrapWithMarkers(command: string, markers: RunMarkers): string {
	return `echo ${markers.start}; ${command}; echo ${markers.end}:$?`;
}

export interface MarkedRun {
	/** Output strictly between the two marker lines — the command's own stdout/stderr, nothing older. */
	output: string;
	/** True once the end marker (and so the command) was actually observed. */
	completed: boolean;
	/** Only set when `completed`. */
	exitCode: number | null;
	/** True when even the START marker could not be found — `output` is then the raw, undelimited pane. */
	truncated: boolean;
}

/**
 * Pull just the new command's output out of a pane that also carries the line that started it
 * (echoed back by the terminal as it was typed) and, once done, the next prompt — using the
 * markers `wrapWithMarkers` sent.
 *
 * Markers are matched only as a WHOLE line (`^marker$`), never as a substring: the typed line
 * that started the command contains both marker strings too, as literal text ("echo
 * __pags_run_start_…__; …") — but `echo __pags_run_start_…__` on its own only ever PRINTS the
 * bare marker on a line by itself, which is the only occurrence this must match.
 */
export function extractBetweenMarkers(pane: string, markers: RunMarkers): MarkedRun {
	const startRe = new RegExp(`^${escapeRegExp(markers.start)}$`, "m");
	const endRe = new RegExp(`^${escapeRegExp(markers.end)}:(-?\\d+)$`, "m");
	const startMatch = startRe.exec(pane);
	if (!startMatch) return { output: pane, completed: false, exitCode: null, truncated: true };
	const afterStart = pane.slice(startMatch.index + startMatch[0].length).replace(/^\n/, "");
	const endMatch = endRe.exec(afterStart);
	if (!endMatch) return { output: afterStart, completed: false, exitCode: null, truncated: false };
	const output = afterStart.slice(0, endMatch.index).replace(/\n$/, "");
	return { output, completed: true, exitCode: Number(endMatch[1]), truncated: false };
}

/** How often {@link waitForMarker} polls, and its default/maximum wait — the ceiling the relay route (`once()`, 120s) must outlast. */
export const RUN_POLL_MS = 150;
export const RUN_DEFAULT_TIMEOUT_MS = 3_000;
export const RUN_MAX_TIMEOUT_MS = 90_000;
/** Capture window while waiting for an end marker: generous, since a command's own output can be long before it finishes. */
export const RUN_CAPTURE_LINES = 2000;

/**
 * Poll-capture a pane until `markers.end` appears (the command finished) or `timeoutMs` elapses.
 *
 * Unlike {@link waitForPaneSettle}, which infers "done" from the pane going quiet — wrong for a
 * build that is still running but paused between log lines — this looks for the exact sentinel
 * `wrapWithMarkers` planted, so "finished" is observed rather than guessed, for as long as the
 * caller is willing to wait. Pure given `captureFn`, so it is tested without a real tmux session.
 */
export async function waitForMarker(
	target: string,
	markers: RunMarkers,
	opts: { timeoutMs?: number; pollMs?: number; lines?: number; captureFn?: (t: string, lines: number) => string } = {},
): Promise<string> {
	const timeoutMs = opts.timeoutMs ?? RUN_DEFAULT_TIMEOUT_MS;
	const pollMs = opts.pollMs ?? RUN_POLL_MS;
	const lines = opts.lines ?? RUN_CAPTURE_LINES;
	const capture = opts.captureFn ?? ((t: string, l: number) => capturePane(t, l));
	const endRe = new RegExp(`^${escapeRegExp(markers.end)}:(-?\\d+)$`, "m");
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const pane = capture(target, lines);
		if (endRe.test(pane)) return pane;
		if (Date.now() >= deadline) return pane;
		await new Promise<void>((r) => setTimeout(r, pollMs));
	}
}

// ── Cursor-based polling for tmux_capture_pane (#1406) ──────────────────────────────────────
//
// Repeatedly polling a long-running pane with plain `capturePane` re-reads (and the caller
// re-pays tokens for) everything already seen. The cursor below needs no server-side state: it
// is the previously captured text's length plus a hash of everything up to it, so the NEXT call
// can verify it is still looking at the same history before trusting a diff off it.

function hashPrefix(s: string): string {
	return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

/** An opaque, self-verifying cursor over a pane's captured text. */
export function encodeCursor(text: string): string {
	return `${text.length}:${hashPrefix(text)}`;
}

function decodeCursor(cursor: string): { length: number; hash: string } | null {
	const m = /^(\d+):([0-9a-f]{16})$/.exec(cursor.trim());
	return m ? { length: Number(m[1]), hash: m[2] } : null;
}

export const SINCE_CAPTURE_LINES = 4000;

export interface SinceCapture {
	pane: string;
	cursor: string;
	/** False when `since` was given but could not be trusted (invalid, or the pane moved past it — cleared, or tmux evicted the history under it); `pane` is then the FULL capture, not a delta. */
	sinceValid: boolean;
}

/**
 * Capture a pane, returning only what is new since a previous call's cursor — so polling a long
 * build doesn't have to re-read everything already seen.
 *
 * Stateless by design: the cursor carries everything needed to verify itself rather than the
 * runner remembering a position per caller, which would need an owner and an expiry. A pane is
 * append-only in the common case, so the previous text should be an exact PREFIX of this one;
 * the hash catches when it is not (cleared, or history tmux evicted) and degrades to returning
 * everything rather than a silently wrong diff.
 */
export function capturePaneSince(
	target: string,
	since: string | undefined,
	lines = SINCE_CAPTURE_LINES,
	/** Override for testing — avoids needing a live tmux session. */
	captureFn: (t: string, l: number) => string = capturePane,
): SinceCapture {
	const full = captureFn(target, lines);
	if (!since) return { pane: full, cursor: encodeCursor(full), sinceValid: true };
	const cursor = decodeCursor(since);
	const matches = cursor !== null && full.length >= cursor.length && hashPrefix(full.slice(0, cursor.length)) === cursor.hash;
	if (!matches) return { pane: full, cursor: encodeCursor(full), sinceValid: false };
	return { pane: full.slice(cursor.length), cursor: encodeCursor(full), sinceValid: true };
}
