import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { capturePane, createSession, killSession, listSessionsDetailed, runCommand as tmuxRunCommand, sendKey as tmuxSendKey, sendText as tmuxSendText, sessionExists, tmuxExec } from "./tmux.js";

export type TerminalBackend = "tmux" | "kitty" | "iterm2";

export interface TerminalTarget {
	backend: TerminalBackend;
	id: string;
	name: string;
	attached?: boolean;
	activeCommand?: string;
	activeWindow?: string;
	created?: string;
}

function shellPath(): string {
	return process.env.SHELL || "/bin/zsh";
}

function expandWorkDir(workDir?: string): string {
	return resolve(String(workDir || "~").replace(/^~(?=$|\/)/, homedir()));
}

export function splitTerminalTarget(raw: string, fallback?: TerminalBackend): { backend: TerminalBackend; id: string } {
	const value = String(raw || "").trim();
	const m = value.match(/^(tmux|kitty|iterm2):(.+)$/i);
	if (m) return { backend: m[1].toLowerCase() as TerminalBackend, id: m[2].trim() };
	if (!fallback) throw new Error("A target must include a backend prefix like `tmux:main`, or pass `backend` separately.");
	return { backend: fallback, id: value };
}

export function listTerminalTargets(backend: TerminalBackend | "all" = "all"): TerminalTarget[] {
	const out: TerminalTarget[] = [];
	if (backend === "all" || backend === "tmux") {
		for (const s of listSessionsDetailed()) {
			out.push({
				backend: "tmux",
				id: s.name,
				name: s.name,
				attached: s.attached,
				activeCommand: s.activeCommand,
				activeWindow: s.activeWindow,
				created: s.created,
			});
		}
	}
	if (backend === "all" || backend === "kitty") out.push(...listKittyTargets());
	if (backend === "all" || backend === "iterm2") out.push(...listItermTargets());
	return out;
}

export function captureTerminalTarget(target: string, opts: { backend?: TerminalBackend; lines?: number } = {}): string {
	const t = splitTerminalTarget(target, opts.backend);
	switch (t.backend) {
		case "tmux":
			if (!sessionExists(t.id)) throw new Error(`No tmux session "${t.id}".`);
			return capturePane(t.id, Math.min(Math.max(Number(opts.lines) || 200, 1), 2000));
		case "kitty":
			return kittyExec(["@", "get-text", "--match", `id:${t.id}`, "--extent", "all"], 5000);
		case "iterm2":
			return itermSessionScript(t.id, "return contents of theSession");
	}
}

/**
 * The foreground command running in a target right now — `claude`, `node`, `zsh`, … (#348).
 *
 * The platform cannot measure what an AI CLI inside a pane spends: a pane holds rendered text, not
 * the stream-json `result` event `headless.ts` reads. So the cloud records the drive as UNMETERED
 * instead, and this is the one fact that makes that record specific rather than generic. It is a
 * name, never a number — no cost figure is ever parsed out of pane output, because a scraped
 * dollar amount would be a guess dressed as a measurement.
 *
 * Returns `null` when it cannot be read (no such target, iTerm2, a backend that will not say).
 * `null` means UNREADABLE and must not be flattened into "nothing was running" upstream: the
 * distinction is the entire point of recording this at all.
 */
export function activeTerminalCommand(target: string, backend?: TerminalBackend): string | null {
	let t: { backend: TerminalBackend; id: string };
	try {
		t = splitTerminalTarget(target, backend);
	} catch {
		return null;
	}
	try {
		switch (t.backend) {
			case "tmux": {
				const out = tmuxExec(["display-message", "-p", "-t", t.id, "#{pane_current_command}"]).trim();
				// `#{pane_current_command}` reads the pane process's argv, and Claude Code rewrites
				// its own — measured on this platform's flagship case, tmux answered `2.1.226` (the
				// version) for a pane whose process `comm` was `claude`. So `aiCliDrives` was 0 for a
				// week of driving Claude Code through a tmux Operator. `comm` is the executable name
				// and no title rewrite touches it, so ask the process tree when the argv is not a
				// name (#498). Only then: a pane reporting `zsh` genuinely has nothing in the
				// foreground, and promoting a background child would be an invention.
				return resolvePaneCommand(out, () => paneDescendantComms(t.id));
			}
			case "kitty":
				return kittyForegroundCommand(t.id);
			// iTerm2 exposes no cheap, reliable foreground-process query. Saying so is the honest
			// answer; guessing from the pane's last line would not be.
			case "iterm2":
				return null;
		}
	} catch {
		return null;
	}
}

/** Shell names that mean "the pane is at a prompt", not "this program is running". */
const SHELL_NAMES = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "login", "screen", "tmux"]);

/** A program name is a bare token. A version (`2.1.226`) and a sentence are both NOT one. */
export function looksLikeCommandName(raw: string): boolean {
	const value = String(raw ?? "").trim();
	if (!value || value.length > 60) return false;
	if (/^v?\d+(\.\d+)+$/.test(value)) return false; // a version string is not a program name
	return /^[A-Za-z_][\w.@+-]*$/.test(value);
}

/**
 * What the pane is running, given what tmux SAID and a way to ask the process tree (#498).
 *
 * Pure so the measured fixture — tmux says `2.1.226`, the pane's child `comm` is `claude` — is a
 * unit test rather than a story. Keeps tmux's answer whenever it is a name: that is the fast path,
 * it costs no extra exec, and the descendant walk can only ever be a second-best guess.
 */
export function resolvePaneCommand(reported: string, listDescendantComms: () => string[]): string | null {
	const value = String(reported ?? "").trim();
	if (looksLikeCommandName(value)) return value;
	// The probe is best-effort by construction: `pgrep`/`ps` availability differs by platform, and
	// a missing one must degrade to what tmux said, not lose it.
	let descendants: string[] = [];
	try {
		descendants = listDescendantComms();
	} catch {
		descendants = [];
	}
	for (const raw of descendants) {
		const name = (String(raw ?? "").trim().split("/").pop() ?? "").trim();
		if (!looksLikeCommandName(name)) continue;
		if (SHELL_NAMES.has(name.toLowerCase())) continue;
		return name;
	}
	// Nothing better found: hand back exactly what tmux said. The cloud decides what an
	// unreadable value means; this module does not invent a name it did not read.
	return value || null;
}

/** Bounded, so a probe on a path a Loop drives continuously can never become the slow part. */
const PROBE_TIMEOUT_MS = 1_000;

/** `comm` for the pane's descendant processes, nearest first. `[]` on any failure. */
function paneDescendantComms(paneId: string): string[] {
	let pid = "";
	try {
		pid = tmuxExec(["display-message", "-p", "-t", paneId, "#{pane_pid}"], PROBE_TIMEOUT_MS).trim();
	} catch {
		return [];
	}
	if (!/^\d+$/.test(pid)) return [];
	const found: string[] = [];
	let frontier = [pid];
	// Two levels is enough for `zsh → claude` and for one wrapper in between, and it bounds the
	// work: `pgrep`/`ps` availability differs by platform, so every step degrades to today's
	// answer rather than throwing (the runner is macOS/Linux; kitty and iTerm2 are untouched).
	for (let depth = 0; depth < 2 && frontier.length > 0; depth++) {
		const children = childPids(frontier);
		if (children.length === 0) break;
		found.push(...commsFor(children));
		frontier = children;
	}
	return found;
}

function childPids(parents: string[]): string[] {
	try {
		const out = execFileSync("pgrep", ["-P", parents.join(",")], {
			encoding: "utf8",
			timeout: PROBE_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.split("\n").map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).slice(0, 16);
	} catch {
		return []; // pgrep exits non-zero when nothing matches — that is an answer, not an error
	}
}

function commsFor(pids: string[]): string[] {
	try {
		const out = execFileSync("ps", ["-o", "comm=", "-p", pids.join(",")], {
			encoding: "utf8",
			timeout: PROBE_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.split("\n").map((s) => s.trim()).filter(Boolean);
	} catch {
		return [];
	}
}

/** The foreground process of a kitty window, from `kitty @ ls`. Null if it can't be determined. */
function kittyForegroundCommand(id: string): string | null {
	try {
		const parsed = JSON.parse(kittyExec(["@", "ls"], 5000)) as unknown;
		if (!Array.isArray(parsed)) return null;
		for (const osWindow of parsed) {
			const tabs = Array.isArray((osWindow as { tabs?: unknown }).tabs) ? (osWindow as { tabs: unknown[] }).tabs : [];
			for (const tab of tabs) {
				const windows = Array.isArray((tab as { windows?: unknown }).windows) ? (tab as { windows: unknown[] }).windows : [];
				for (const win of windows) {
					const row = win as Record<string, unknown>;
					if (String(row.id ?? "") !== id) continue;
					const procs = Array.isArray(row.foreground_processes) ? (row.foreground_processes as unknown[]) : [];
					for (const p of procs) {
						const cmdline = (p as { cmdline?: unknown }).cmdline;
						const first = Array.isArray(cmdline) ? String(cmdline[0] ?? "").trim() : "";
						if (first) return first;
					}
					return null;
				}
			}
		}
		return null;
	} catch {
		return null;
	}
}

export function runTerminalCommand(target: string, command: string, backend?: TerminalBackend): string {
	const t = splitTerminalTarget(target, backend);
	if (!command.trim()) throw new Error("A `command` is required.");
	switch (t.backend) {
		case "tmux":
			if (!sessionExists(t.id)) throw new Error(`No tmux session "${t.id}".`);
			tmuxRunCommand(t.id, command);
			return capturePane(t.id, 200);
		case "kitty":
			kittyExec(["@", "send-text", "--match", `id:${t.id}`, command]);
			kittyExec(["@", "send-key", "--match", `id:${t.id}`, "enter"]);
			return captureTerminalTarget(t.id, { backend: "kitty" });
		case "iterm2":
			itermSessionScript(t.id, `tell theSession to write text ${appleString(command)}`);
			return captureTerminalTarget(t.id, { backend: "iterm2" });
	}
}

export function sendTerminalKeys(target: string, opts: { backend?: TerminalBackend; text?: string; keys?: string[] }): string {
	const t = splitTerminalTarget(target, opts.backend);
	if (opts.text == null && (!opts.keys || opts.keys.length === 0)) throw new Error("Provide `text` and/or `keys` to send.");
	switch (t.backend) {
		case "tmux":
			if (!sessionExists(t.id)) throw new Error(`No tmux session "${t.id}".`);
			if (opts.text != null) tmuxSendText(t.id, opts.text);
			for (const key of opts.keys ?? []) tmuxSendKey(t.id, key);
			return capturePane(t.id, 200);
		case "kitty":
			if (opts.text != null) kittyExec(["@", "send-text", "--match", `id:${t.id}`, opts.text]);
			for (const key of opts.keys ?? []) kittyExec(["@", "send-key", "--match", `id:${t.id}`, kittyKeyName(key)]);
			return captureTerminalTarget(t.id, { backend: "kitty" });
		case "iterm2":
			if ((opts.keys ?? []).length > 0) throw new Error("iTerm2 generic key events are not supported yet; send text or run a command.");
			itermSessionScript(t.id, `tell theSession to write text ${appleString(opts.text ?? "")}`);
			return captureTerminalTarget(t.id, { backend: "iterm2" });
	}
}

export function createTerminalTarget(opts: { backend: TerminalBackend; name?: string; workDir?: string; command?: string }): { id: string; name: string; backend: TerminalBackend; existed?: boolean; workDir?: string } {
	const workDir = expandWorkDir(opts.workDir);
	switch (opts.backend) {
		case "tmux": {
			const name = String(opts.name || "").trim();
			if (!name) throw new Error("A `name` is required for tmux.");
			if (sessionExists(name)) return { backend: "tmux", id: name, name, existed: true, workDir };
			createSession(name, workDir, opts.command);
			return { backend: "tmux", id: name, name, workDir };
		}
		case "kitty": {
			const args = ["@", "launch", "--type", "os-window", "--cwd", workDir];
			if (opts.command) args.push(shellPath(), "-lc", opts.command);
			const id = kittyExec(args).trim();
			return { backend: "kitty", id, name: opts.name || id, workDir };
		}
		case "iterm2": {
			const script = [
				'tell application "iTerm2"',
				"create window with default profile",
				"set theSession to current session of current window",
				`tell theSession to write text ${appleString(`cd ${shellQuote(workDir)}${opts.command ? ` && ${opts.command}` : ""}`)}`,
				"return ((index of current window) as text) & \":1:1\"",
				"end tell",
			].join("\n");
			const id = osascript(script).trim() || "1:1:1";
			return { backend: "iterm2", id, name: opts.name || id, workDir };
		}
	}
}

export function killTerminalTarget(target: string, backend?: TerminalBackend): boolean {
	const t = splitTerminalTarget(target, backend);
	switch (t.backend) {
		case "tmux":
			return killSession(t.id);
		case "kitty":
			kittyExec(["@", "close-window", "--match", `id:${t.id}`]);
			return true;
		case "iterm2":
			itermCloseTarget(t.id);
			return true;
	}
}

function listKittyTargets(): TerminalTarget[] {
	try {
		const raw = kittyExec(["@", "ls"], 5000);
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		const out: TerminalTarget[] = [];
		for (const osWindow of parsed) {
			const tabs = Array.isArray((osWindow as { tabs?: unknown }).tabs) ? (osWindow as { tabs: unknown[] }).tabs : [];
			for (const tab of tabs) {
				const windows = Array.isArray((tab as { windows?: unknown }).windows) ? (tab as { windows: unknown[] }).windows : [];
				for (const win of windows) {
					const row = win as Record<string, unknown>;
					const id = String(row.id ?? "").trim();
					if (!id) continue;
					const title = String(row.title ?? row.user_vars ?? id);
					out.push({ backend: "kitty", id, name: title || id, activeWindow: String((tab as Record<string, unknown>).title ?? "") });
				}
			}
		}
		return out;
	} catch {
		return [];
	}
}

function listItermTargets(): TerminalTarget[] {
	try {
		const script = [
			'set out to ""',
			'tell application "iTerm2"',
			"repeat with wi from 1 to count of windows",
			"repeat with ti from 1 to count of tabs of window wi",
			"repeat with si from 1 to count of sessions of tab ti of window wi",
			"set sid to (wi as text) & \":\" & (ti as text) & \":\" & (si as text)",
			"set sname to name of session si of tab ti of window wi",
			"set out to out & sid & (ASCII character 9) & sname & linefeed",
			"end repeat",
			"end repeat",
			"end repeat",
			"end tell",
			"return out",
		].join("\n");
		return osascript(script)
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.flatMap((line): TerminalTarget[] => {
				const [id, name] = line.split("\t");
				return id ? [{ backend: "iterm2", id, name: name || id }] : [];
			});
	} catch {
		return [];
	}
}

function kittyExec(args: string[], timeoutMs = 5000): string {
	try {
		return execFileSync("kitty", args, { encoding: "utf8", timeout: timeoutMs, stdio: "pipe" });
	} catch (e) {
		throw new Error(`kitty remote control is unavailable. Start kitty with remote control enabled (for example, allow_remote_control yes). ${e instanceof Error ? e.message : String(e)}`);
	}
}

function osascript(script: string): string {
	try {
		return execFileSync("osascript", ["-e", script], { encoding: "utf8", timeout: 5000, stdio: "pipe" });
	} catch (e) {
		throw new Error(`iTerm2 automation is unavailable. Open iTerm2 and grant macOS Automation/Accessibility permission if prompted. ${e instanceof Error ? e.message : String(e)}`);
	}
}

function itermSessionScript(target: string, command: string): string {
	const [w, t, s] = target.split(":").map((v) => Math.max(1, Number.parseInt(v, 10) || 1));
	const script = [
		'tell application "iTerm2"',
		`set theSession to session ${s} of tab ${t} of window ${w}`,
		command,
		"end tell",
	].join("\n");
	return osascript(script);
}

function itermCloseTarget(target: string): string {
	const [w, t] = target.split(":").map((v) => Math.max(1, Number.parseInt(v, 10) || 1));
	const script = [
		'tell application "iTerm2"',
		`close tab ${t} of window ${w}`,
		"end tell",
	].join("\n");
	return osascript(script);
}

function appleString(s: string): string {
	return JSON.stringify(s);
}

function shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

function kittyKeyName(key: string): string {
	const k = key.trim();
	if (/^enter$/i.test(k)) return "enter";
	if (/^escape$/i.test(k)) return "escape";
	if (/^tab$/i.test(k)) return "tab";
	if (/^backspace$/i.test(k)) return "backspace";
	if (/^c-/i.test(k)) return `ctrl+${k.slice(2).toLowerCase()}`;
	return k.toLowerCase();
}
