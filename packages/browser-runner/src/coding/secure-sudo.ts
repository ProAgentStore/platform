/**
 * Run ONE owner-approved command under `sudo`, with the password on STDIN (#1131).
 *
 * `secure_input_inject` types a secret into a terminal pane, and a pane cannot be told whether a masked prompt took it: nothing is echoed, so
 * the value can never be confirmed, and every failed guess uses one of sudo's three tries. The owner's decision was not to type at all.
 * Here the runner starts `sudo -S -p '' -- <argv>` ITSELF and writes the value to sudo's stdin:
 *
 *   • the value is never in an argument list, an environment variable, a shell string, a tmux buffer or a pane. The command is an argv ARRAY
 *     handed to `spawn` with no shell, so nothing in it is interpreted, and the value is the one thing that is not in it;
 *   • success is sudo's EXIT CODE, not a guess at what a pane printed: 0 is delivered, anything else is not;
 *   • what comes back is sudo's stderr and the command's stdout with the value cut out of them, bounded.
 *
 * It does exactly one attempt. A wrong password makes sudo count one incorrect try, and it must not be repeated on the owner's behalf: a retry
 * is the platform's decision, taken only when a person asks for one. The platform owns the rest (which command was approved, when the secret is
 * spent); this module owns only what happens between the value and sudo, and refuses a malformed request before a process exists.
 *
 * Its own route (`POST /secure/sudo`) so there is one more body this runner promises never to log or put in an error.
 */
import { spawn } from "node:child_process";
import { RunnerInputError } from "../errors.js";

/** What the platform sends: the approved argv (without `sudo`) and the value. `timeoutMs` only ever shortens the default. */
export interface SecureSudoBody {
	command?: unknown;
	value?: unknown;
	timeoutMs?: unknown;
}

export interface SecureSudoResult {
	/** sudo exited 0 — the command ran, which also means the password was accepted (or a cached credential made it unnecessary). */
	ok: boolean;
	exitCode: number | null;
	signal: string | null;
	/** The runner stopped it at the deadline; the command may have partly run. */
	timedOut: boolean;
	/** The command's output, the value cut out, bounded to the tail. */
	stdout: string;
	/** sudo's own words (and the command's stderr), the value cut out, bounded to the tail. */
	stderr: string;
	/** Set when the process could not be started at all (no `sudo` on this machine). */
	spawnError?: string;
}

export interface SecureSudoDeps {
	/** `spawn` — injectable so a test sees every argv, option and stdin byte this module ever hands a process. */
	spawn: typeof spawn;
}

/** The longest the command may run before the runner stops it. */
export const SUDO_DEFAULT_TIMEOUT_MS = 45_000;
const SUDO_MIN_TIMEOUT_MS = 1_000;
/** How much of each stream is kept: the tail, where the failure is. */
export const SUDO_OUTPUT_KEEP = 4_000;
/** What is read at most before the stream is dropped, so a chatty command cannot fill memory. */
const SUDO_OUTPUT_READ = 64_000;
const MAX_ARGS = 32;
const MAX_ARG_CHARS = 2_048;
const MAX_VALUE_CHARS = 1_024;
/** A control character (NUL, newline, escape, DEL…): not part of one argument, and not something a person typed into a command. */
function hasControlChar(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x20 || c === 0x7f) return true;
	}
	return false;
}

/** The approved command as argv, or the refusal. Pure: no process exists yet. */
export function approvedArgv(command: unknown): string[] {
	if (!Array.isArray(command) || command.length === 0) throw new RunnerInputError("`command` must be a non-empty array of strings: the program and its arguments, as argv.");
	if (command.length > MAX_ARGS) throw new RunnerInputError(`\`command\` has more than ${MAX_ARGS} elements.`);
	for (const part of command) {
		if (typeof part !== "string" || part.length === 0 || part.length > MAX_ARG_CHARS) throw new RunnerInputError(`Every element of \`command\` must be a string of 1-${MAX_ARG_CHARS} characters.`);
		if (hasControlChar(part)) throw new RunnerInputError("`command` may not contain control characters (a newline or NUL would not be one argument).");
	}
	const argv = command as string[];
	// After `--` sudo takes the first element as the program. One that is `sudo` itself, or an option, is not a command an owner meant to approve.
	if (argv[0] === "sudo" || argv[0].startsWith("-")) throw new RunnerInputError("`command` must start with the program to run, not `sudo` or an option: the runner adds `sudo -S -p '' --` itself.");
	return argv;
}

/** `text` with every occurrence of the value (and of the value trimmed) cut out. */
export function withoutValue(text: string, value: string): string {
	let out = text;
	for (const needle of new Set([value, value.trim()])) if (needle) out = out.split(needle).join("[redacted]");
	return out;
}

function tail(text: string): string {
	return text.length > SUDO_OUTPUT_KEEP ? `[cut: showing the last ${SUDO_OUTPUT_KEEP} of ${text.length} characters]\n${text.slice(-SUDO_OUTPUT_KEEP)}` : text;
}

export async function secureSudo(body: SecureSudoBody, deps: SecureSudoDeps): Promise<SecureSudoResult> {
	const argv = approvedArgv(body.command);
	// A pasted password often ends in a stray newline; sudo reads one line, so the line break is not part of it. One inside is not a password.
	const value = (typeof body.value === "string" ? body.value : "").replace(/[\r\n]+$/, "");
	if (!value) throw new RunnerInputError("Nothing to deliver: `value` is empty.");
	if (value.length > MAX_VALUE_CHARS || value.includes("\u0000") || value.includes("\n") || value.includes("\r")) throw new RunnerInputError(`\`value\` must be one line of at most ${MAX_VALUE_CHARS} characters.`);
	const asked = typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs) ? Math.trunc(body.timeoutMs) : SUDO_DEFAULT_TIMEOUT_MS;
	const timeoutMs = Math.min(Math.max(asked, SUDO_MIN_TIMEOUT_MS), SUDO_DEFAULT_TIMEOUT_MS);

	// `-S` reads the password from stdin; `-p ''` prints no prompt; `--` ends sudo's options, so nothing after it is read as one. No shell.
	const args = ["-S", "-p", "", "--", ...argv];
	// The runner's own environment, minus anything that would make sudo ask somewhere else. The value is not in it, and is not added to it.
	const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", LANG: "C" };
	delete env.SUDO_ASKPASS;

	return new Promise<SecureSudoResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const finish = (r: Omit<SecureSudoResult, "stdout" | "stderr" | "timedOut">) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ...r, timedOut, stdout: tail(withoutValue(stdout, value)), stderr: tail(withoutValue(stderr, value)) });
		};
		const child = deps.spawn("sudo", args, { stdio: ["pipe", "pipe", "pipe"], env, windowsHide: true });
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		const keep = (into: "out" | "err") => (chunk: Buffer | string) => {
			const text = chunk.toString();
			if (into === "out") stdout = stdout.length < SUDO_OUTPUT_READ ? stdout + text : stdout;
			else stderr = stderr.length < SUDO_OUTPUT_READ ? stderr + text : stderr;
		};
		child.stdout?.on("data", keep("out"));
		child.stderr?.on("data", keep("err"));
		child.on("error", (e: NodeJS.ErrnoException) => {
			// The message of a spawn failure quotes the file and argv — never the value, which is not in either — but names are all it needs.
			finish({ ok: false, exitCode: null, signal: null, spawnError: e.code === "ENOENT" ? "`sudo` is not installed on this machine." : `sudo could not be started (${e.code ?? "error"}).` });
		});
		child.on("close", (code, signal) => finish({ ok: code === 0, exitCode: code, signal: signal ?? null }));
		// sudo may exit before it reads (a cached credential, a refused command): a write to a closed pipe is not a failure of ours.
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(`${value}\n`);
	});
}

/** The route: the real `spawn`. */
export async function secureSudoRoute(body: SecureSudoBody): Promise<SecureSudoResult> {
	return secureSudo(body, { spawn });
}
