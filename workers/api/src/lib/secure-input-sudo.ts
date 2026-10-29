/**
 * Deliver a ready secure input to `sudo` — through its stdin, by the runner, never typed into a pane (#1131).
 *
 * `secure_input_inject` types into a terminal and judges the result by what the pane shows. A masked prompt shows nothing, so a
 * password could not be confirmed, and each failed guess cost one of sudo's three tries. The owner's decision (2026-10-29): deliver it to
 * `sudo -S -p '' -- <command>` over stdin, report success by the EXIT CODE, and never type.
 *
 *   • The command is part of the REQUEST, fixed when it was created and approved by the owner when they submitted the value
 *     (`storeSecretValue` refuses a sudo request's value without that approval). This module takes no command from its caller: an agent
 *     cannot point a stored password at anything the owner did not read.
 *   • The value is claimed (spent) first, so two calls cannot both run a sudo attempt. Only exit 0 keeps it spent. Any other outcome puts
 *     it back, ready — a wrong password, a command sudo's policy refuses, a timeout, a runner that cannot be reached — and says why, in
 *     sudo's own words with the value cut out. There is no retry here and no loop: the next attempt is a new call by a person or an agent
 *     that read the reason. `/secure/sudo` is also `retry: "never"` in the runner route table, so nothing re-sends it after a dispatch.
 *   • Not exempt from the owner's approval, and not gated on the tmux/terminal write consent: that consent exists because the AGENT picks
 *     the pane it types into. Here the agent picks nothing — the program, its arguments and the machine's sudo policy are what the owner
 *     approved — so the per-request approval is the stronger control, and a second blanket one would only be a way to forget to turn it on.
 *
 * The value leaves this module in exactly one place: the body of the runner call. It is never in the result, a log line or an error.
 */
import type { Env } from "../types.js";
import { callRunner, getBoundRunnerConn } from "./runner-client.js";
import { runnerErrorDispatched } from "./runner-unreachable.js";
import { runnerUpgradeClause } from "./runner-upgrade.js";
import { consumeSecureInput, getSecureInputStatus, restoreConsumedSecureInput } from "./secure-input.js";
import { clipMarked } from "./clip-marked.js";

/** The CLI release whose runner serves `POST /secure/sudo`. */
export const SECURE_SUDO_MIN_CLI = "0.4.190";

/** How long the runner lets the command run, and how long the platform waits for the runner's answer (a little longer, so the runner's wins). */
export const SUDO_RUNNER_TIMEOUT_MS = 45_000;
const SUDO_CALL_TIMEOUT_MS = 60_000;

/** What of sudo's output is passed on, so a chatty command cannot fill a tool result. */
const OUTPUT_KEEP = 2_000;

const MAX_ARGS = 32;
const MAX_ARG_CHARS = 2_048;

/** A control character (NUL, newline, escape, DEL…): not part of one argument, and not something a person typed into a command. */
function hasControlChar(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x20 || c === 0x7f) return true;
	}
	return false;
}

/** The command an owner is asked to approve, as the runner will run it, or why it cannot be one. Pure. */
export function validateSudoCommand(raw: unknown): { ok: true; argv: string[] } | { ok: false; error: string } {
	if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "command must be a non-empty array of strings: the program and its arguments, e.g. [\"pmset\", \"-a\", \"autorestart\", \"1\"]" };
	if (raw.length > MAX_ARGS) return { ok: false, error: `command has more than ${MAX_ARGS} elements` };
	for (const part of raw) {
		if (typeof part !== "string" || part.length === 0 || part.length > MAX_ARG_CHARS) return { ok: false, error: `every element of command must be a string of 1-${MAX_ARG_CHARS} characters` };
		if (hasControlChar(part)) return { ok: false, error: "command may not contain control characters (a newline or NUL would not be one argument)" };
	}
	const argv = raw as string[];
	if (argv[0] === "sudo" || argv[0].startsWith("-")) return { ok: false, error: "command starts with the program to run, not `sudo` or an option: the platform adds `sudo -S -p '' --` itself" };
	return { ok: true, argv };
}

/** The command as the owner reads it: `sudo -- pmset -a autorestart 1`. Display only — the runner is handed the array, never this string. */
export function commandLine(argv: string[]): string {
	const quote = (a: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
	return `sudo -- ${argv.map(quote).join(" ")}`;
}

/** What `/secure/sudo` answers (packages/browser-runner `SecureSudoResult`). */
interface RunnerSudoResult {
	ok?: boolean;
	exitCode?: number | null;
	signal?: string | null;
	timedOut?: boolean;
	stdout?: string;
	stderr?: string;
	spawnError?: string;
}

export interface SecureSudoOutcome {
	/** sudo exited 0: the command ran. The ONLY thing that sets this. */
	delivered: boolean;
	/** Why not, in words an operator can act on — sudo's own, with the value cut out. Absent when delivered. */
	reason?: string;
	/** The value is spent. True only after a delivery, or when it could not be put back. */
	consumedValue: boolean;
	/** The request's status after this call: `consumed` after a delivery, `ready` after any failure that left it usable. */
	status: string;
	/** The approved command, as argv and as the line the owner read. Not secret. */
	command: string[] | null;
	commandLine: string | null;
	exitCode?: number | null;
	timedOut?: boolean;
	/** The command's output and sudo's stderr, the value cut out, bounded. */
	stdout?: string;
	stderr?: string;
	/** The value's character count, as `secure_input_status` reports it. */
	length?: number;
}

/** A runner error names the route or the endpoint — and is scrubbed of the value regardless. */
function errorText(e: unknown, value: string): string {
	const msg = e instanceof Error ? e.message.replace(/^Runner \/secure\/sudo → \d+: /, "") : String(e);
	return clip(value ? msg.split(value).join("[redacted]") : msg);
}

const clip = (s: string) => clipMarked(s, OUTPUT_KEEP, { keep: "tail" });
const scrub = (s: string | undefined, value: string) => clip((s ?? "").split(value).join("[redacted]").split(value.trim()).join("[redacted]"));

/** `/secure/sudo` answers 404 only from a runner that predates it. */
function runnerLacksSecureSudo(e: unknown): boolean {
	return /^Runner \/secure\/sudo → 404/.test(e instanceof Error ? e.message : String(e));
}

/** What sudo said, turned into the next step. Reads the redacted stderr, so it can never carry the value. */
function adviceFor(stderr: string): string {
	if (/incorrect password|Sorry, try again|no password was provided|Authentication failure/i.test(stderr)) {
		return " sudo rejected the password and counted one incorrect attempt; sending the same value again will fail the same way, so ask the owner for the right one with a new secure_input_request.";
	}
	if (/is not allowed to execute|not in the sudoers file|may not run sudo|is not allowed to run sudo/i.test(stderr)) {
		return " sudo's policy on that machine does not let this user run this command, so a retry will not help.";
	}
	return "";
}

export async function runSecureInputSudo(env: Env, input: { instanceId: string; userId: string; requestId: string }): Promise<SecureSudoOutcome | null> {
	const status = await getSecureInputStatus(env, input.requestId, input.instanceId, input.userId);
	if (!status) return null;
	const command = status.command ?? null;
	const base = { command, commandLine: command ? commandLine(command) : null, length: status.length };
	const refuse = (reason: string): SecureSudoOutcome => ({ ...base, delivered: false, reason, consumedValue: false, status: status.status });

	if (status.destinationScope !== "sudo") {
		return refuse(`This request is for ${status.destinationScope}, and secure_input_sudo delivers \`sudo\` requests only. Create one with destination_scope "sudo" and the command to run. Nothing was consumed.`);
	}
	if (status.status !== "ready") return refuse(`The request is ${status.status}, not ready — ${status.status === "pending" ? "the owner has not entered the value and approved the command yet" : "there is no value to deliver"}.`);
	if (!command) return refuse("The request carries no command to run. Create a new one. Nothing was consumed.");
	if (!status.commandApproved) return refuse("The owner has not approved this command, so it will not run. Nothing was consumed.");
	if (status.empty) return refuse("The submitted value is empty — ask the owner to enter it again.");

	const conn = await getBoundRunnerConn(env, input.instanceId, input.userId).catch(() => null);
	if (!conn) return refuse("No runner is connected for this agent — run `pags up` on the machine that should run the command. Nothing was consumed.");

	// Spent only now, after every check that could be made without it. Claimed, so a second call cannot make a second sudo attempt.
	const value = await consumeSecureInput(env, input.requestId, input.instanceId, input.userId, { consumedNode: conn.runnerNode ?? null });
	if (value == null) return refuse("The value could not be claimed — it was used or expired a moment ago. Check secure_input_status.");

	// Any outcome but exit 0 puts the value back. `reason` says what happened; this adds what became of the value.
	const putBack = async (reason: string, extra: Partial<SecureSudoOutcome> = {}): Promise<SecureSudoOutcome> => {
		const restored = await restoreConsumedSecureInput(env, input.requestId, input.userId, value).catch(() => false);
		return {
			...base,
			...extra,
			delivered: false,
			reason: restored ? `${reason} The value was NOT consumed and is still ready. Nothing is retried automatically.` : `${reason} The value could not be put back; ask the owner to enter it again with a new secure_input_request.`,
			consumedValue: !restored,
			status: restored ? "ready" : "consumed",
		};
	};

	let answer: RunnerSudoResult;
	try {
		answer = await callRunner<RunnerSudoResult>(conn, "/secure/sudo", { command, value, timeoutMs: SUDO_RUNNER_TIMEOUT_MS }, { timeoutMs: SUDO_CALL_TIMEOUT_MS });
	} catch (e) {
		// A runner that does not know the route is refused, not fallen back from: the only fallback is typing the password, which is the thing this replaces.
		if (runnerLacksSecureSudo(e)) {
			return putBack(`The command did not run: ${runnerUpgradeClause({ what: "run a command under sudo with the password on stdin", minCli: SECURE_SUDO_MIN_CLI, node: conn.runnerNode })}.`);
		}
		// Whether sudo was reached is the question that matters: each attempt costs a try. Say which, and never send it again by itself.
		const reached = runnerErrorDispatched(e);
		return putBack(`${reached ? "The runner did not answer, so it is not known whether sudo ran the command or used a password attempt — check the machine before asking again" : "The runner could not be reached, so sudo was never started"}: ${errorText(e, value)}.`);
	}

	const stdout = scrub(answer.stdout, value);
	const stderr = scrub(answer.stderr, value);
	const exitCode = typeof answer.exitCode === "number" ? answer.exitCode : null;
	if (answer.ok === true && exitCode === 0) {
		return { ...base, delivered: true, consumedValue: true, status: "consumed", exitCode, stdout, stderr };
	}
	const outcome = { exitCode, timedOut: answer.timedOut === true, stdout, stderr };
	if (answer.spawnError) return putBack(`The command did not run: ${answer.spawnError}`, outcome);
	if (answer.timedOut) {
		return putBack(`sudo did not finish within ${SUDO_RUNNER_TIMEOUT_MS / 1000}s and was stopped; the command may have partly run — check the machine before asking again.${stderr ? ` sudo said: ${stderr}` : ""}`, outcome);
	}
	const said = stderr.trim() || "it printed nothing";
	return putBack(`sudo exited ${exitCode ?? answer.signal ?? "without a status"}: ${said}.${adviceFor(stderr)}`, outcome);
}
