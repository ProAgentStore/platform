/**
 * Type a secret into a terminal WITHOUT putting it in any process's argv (#1143).
 *
 * `secure_input_inject` used to type through `/tmux/send` / `/terminal/send`, which run
 * `tmux send-keys -t <session> -l <value>` and `kitty @ send-text --match id:<n> <value>`: the plaintext sat
 * in a child process's argv for the life of the call, readable by any local user through `ps` or
 * `/proc/<pid>/cmdline`, and by whatever records process launches. Here the value travels over STDIN:
 *
 *   • tmux  — `load-buffer -b <one-use name> -` (the value on stdin), then `paste-buffer -d -b <name> -t <session>`,
 *             which deletes the buffer as it pastes; a paste that fails deletes it anyway.
 *   • kitty — `kitty @ send-text --match id:<n> --stdin` (the value on stdin).
 *   • iTerm2 — `osascript -` with the script (and the value inside it) on stdin, `write text … newline NO`: no Return is pressed.
 *
 * Residual trust boundary (#1196): off argv is not off the machine. The value is, briefly, a named tmux buffer any same-user
 * process that can reach the tmux socket may read; an AppleScript in osascript's memory; and afterwards it is in the pane, its
 * scrollback and the program the pane runs (`/secure/scrub` clears scrollback, panes are masked on the way out).
 *
 * Its own route (`POST /secure/type`), so ordinary `tmux_send_keys` text is unaffected, and so there is one body
 * this runner promises never to log or put in an error: errors name the target, never the value — and with the
 * value off argv, a failed command's own message (which quotes its argv) cannot carry it either.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { RunnerInputError } from "../errors.js";
import { itermWriteScript } from "./apple-script.js";

export interface SecureTypeDeps {
	/** `execFileSync` — injectable so a test can see every argv this module ever builds. */
	exec: (file: string, args: string[], opts: { input: string; encoding: "utf8"; timeout: number; stdio: ["pipe", "pipe", "pipe"] }) => string;
	exists: (session: string) => boolean;
	capture: (target: string, backend: "tmux" | "kitty" | "iterm2") => string;
	settle: (session: string) => Promise<string>;
}

/** Deliver `value` to `target` (a bare tmux session, `tmux:<session>` or `kitty:<id>`); the pane before and after. */
export async function secureType(body: { target?: unknown; value?: unknown }, deps: SecureTypeDeps): Promise<{ target: string; pane: string; paneBefore: string; changed: boolean }> {
	const target = typeof body.target === "string" ? body.target.trim() : "";
	const value = typeof body.value === "string" ? body.value : "";
	if (!target) throw new RunnerInputError("A `target` is required.");
	if (!value) throw new RunnerInputError("Nothing to type.");
	const opts = (input: string) => ({ input, encoding: "utf8" as const, timeout: 5000, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] });

	const kitty = /^kitty:(.+)$/i.exec(target);
	if (kitty) {
		const paneBefore = deps.capture(kitty[1], "kitty");
		try {
			deps.exec("kitty", ["@", "send-text", "--match", `id:${kitty[1]}`, "--stdin"], opts(value));
		} catch {
			throw new Error(`Typing into ${target} failed: kitty remote control is unavailable (allow_remote_control yes).`);
		}
		const pane = deps.capture(kitty[1], "kitty");
		return { target, pane, paneBefore, changed: pane !== paneBefore };
	}
	const iterm = /^iterm2:(.+)$/i.exec(target);
	if (iterm) {
		const id = iterm[1].trim();
		const paneBefore = deps.capture(id, "iterm2");
		try {
			deps.exec("osascript", ["-"], opts(itermWriteScript(id, value, false)));
		} catch {
			throw new Error(`Typing into ${target} failed: iTerm2 automation is unavailable.`);
		}
		const pane = deps.capture(id, "iterm2");
		return { target, pane, paneBefore, changed: pane !== paneBefore };
	}

	const session = target.replace(/^tmux:/i, "");
	if (!deps.exists(session)) throw new RunnerInputError(`No tmux session "${session}".`, 404);
	const paneBefore = deps.capture(session, "tmux");
	const buffer = `pags-secure-${randomUUID()}`;
	try {
		deps.exec("tmux", ["load-buffer", "-b", buffer, "-"], opts(value));
		deps.exec("tmux", ["paste-buffer", "-d", "-b", buffer, "-t", session], opts(""));
	} catch {
		throw new Error(`Typing into "${session}" failed: tmux did not accept the paste.`);
	} finally {
		// `-d` deleted it on a paste that ran; this is the paste that did not.
		try {
			deps.exec("tmux", ["delete-buffer", "-b", buffer], opts(""));
		} catch {
			// Already gone — the normal case.
		}
	}
	const pane = await deps.settle(session);
	return { target, pane, paneBefore, changed: pane !== paneBefore };
}

/** The real hands. */
export async function machineSecureTypeDeps(): Promise<SecureTypeDeps> {
	const { capturePane, sessionExists, waitForPaneSettle } = await import("./tmux.js");
	const { captureTerminalTarget } = await import("./terminal.js");
	return {
		exec: (file, args, opts) => execFileSync(file, args, opts),
		exists: sessionExists,
		capture: (t, backend) => (backend === "tmux" ? capturePane(t, 200) : captureTerminalTarget(t, { backend })),
		settle: (session) => waitForPaneSettle(session, { quietMs: 750, timeoutMs: 3_000 }),
	};
}
