/**
 * #1131 — a stored password delivered to `sudo` over stdin, by the runner, never typed into a pane.
 *
 * Real schema, real envelope encryption, real claim/restore SQL; only the machine is faked. What is held to account is the owner's decision:
 *
 *   • the command is fixed on the request and approved by the owner with the value — no approval, no stored value;
 *   • the value reaches exactly one place, the body of the runner call, and no tmux/terminal path is ever called;
 *   • success is sudo's exit code, and only then is the secret spent; every other outcome leaves it `ready`;
 *   • a failure says sudo's reason with the value cut out, and is NEVER retried by the platform;
 *   • nothing — a result, a log line, an error — carries the value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { RunnerUnreachableError, runnerErrorTag } from "./runner-unreachable.js";
import type { Env } from "../types.js";

const { callRunner, getBoundRunnerConn, logError } = vi.hoisted(() => ({ callRunner: vi.fn(), getBoundRunnerConn: vi.fn(), logError: vi.fn(async () => undefined) }));
vi.mock("./runner-client.js", async () => {
	const actual = await vi.importActual<typeof import("./runner-client.js")>("./runner-client.js");
	return { ...actual, callRunner: (...a: unknown[]) => callRunner(...a), getBoundRunnerConn: (...a: unknown[]) => getBoundRunnerConn(...a) };
});
vi.mock("./error-log.js", () => ({ logError: (...a: unknown[]) => logError(...(a as [])) }));

const { commandApproved, createSecureInputRequest, getSecureInputStatus, storeSecretValue } = await import("./secure-input.js");
const { commandLine, runSecureInputSudo, SECURE_SUDO_MIN_CLI, validateSudoCommand } = await import("./secure-input-sudo.js");

const PASSWORD = "c0rrect-h0rse-battery!";
const PMSET = ["pmset", "-a", "autorestart", "1"];
const KEY = "0000000000000000000000000000000000000000000000000000000000000000";

let d1: RealSchemaD1;
let env: Env;
/** Every string that crossed a boundary the value must not: logs, the console, every result. */
let observed: string[];

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: KEY } as unknown as Env;
	observed = [];
	callRunner.mockReset();
	logError.mockClear();
	getBoundRunnerConn.mockReset();
	getBoundRunnerConn.mockResolvedValue({ kind: "relay", instanceId: "i1", runnerNode: "mini", relayName: "i1:node:mini" });
	for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void observed.push(a.map(String).join(" ")));
});
afterEach(() => {
	vi.restoreAllMocks();
	d1.close();
});

/** A request created, its value submitted WITH the owner's approval of exactly `command`. Returns its id. */
async function readyRequest(command: string[] = PMSET): Promise<string> {
	const id = await createSecureInputRequest(env, { instanceId: "i1", userId: "u1", label: "Mac mini sudo password", destinationScope: "sudo", command });
	expect(await storeSecretValue(env, id, "i1", "u1", PASSWORD, { approvedCommand: command })).toBe(true);
	return id;
}
const row = (id: string) => d1.sqlite.prepare("SELECT status, secret_ciphertext IS NOT NULL AS has_secret, command, command_approved_at FROM secure_input_requests WHERE id = ?").get(id) as { status: string; has_secret: number; command: string | null; command_approved_at: string | null };
const deliver = async (id: string) => {
	const r = await runSecureInputSudo(env, { instanceId: "i1", userId: "u1", requestId: id });
	observed.push(JSON.stringify(r));
	return r;
};
/** The runner answers like `/secure/sudo`. */
const runnerSays = (answer: Record<string, unknown>) => callRunner.mockResolvedValue(answer);
const sudoCalls = () => callRunner.mock.calls.filter((c) => c[1] === "/secure/sudo");

describe("the command: fixed on the request, approved with the value", () => {
	it("a sudo request carries its command as argv, visible to the owner and the agent, and is not yet approved", async () => {
		const id = await createSecureInputRequest(env, { instanceId: "i1", userId: "u1", label: "sudo", destinationScope: "sudo", command: PMSET });
		expect(await getSecureInputStatus(env, id, "i1", "u1")).toMatchObject({ destinationScope: "sudo", status: "pending", command: PMSET, commandApproved: false });
		expect(row(id).command).toBe(JSON.stringify(PMSET));
	});

	it("NO approval, NO stored value: a value submitted without the command is refused and the request stays pending with nothing stored", async () => {
		const id = await createSecureInputRequest(env, { instanceId: "i1", userId: "u1", label: "sudo", destinationScope: "sudo", command: PMSET });
		expect(await storeSecretValue(env, id, "i1", "u1", PASSWORD)).toBe(false);
		expect(await storeSecretValue(env, id, "i1", "u1", PASSWORD, { approvedCommand: [] })).toBe(false);
		expect(row(id)).toMatchObject({ status: "pending", has_secret: 0, command_approved_at: null });
	});

	it("an approval of a DIFFERENT command is no approval — shorter, longer, reordered or altered", async () => {
		const id = await createSecureInputRequest(env, { instanceId: "i1", userId: "u1", label: "sudo", destinationScope: "sudo", command: PMSET });
		for (const wrong of [["pmset"], [...PMSET, "--extra"], ["pmset", "-a", "1", "autorestart"], ["pmset", "-a", "autorestart", "0"], ["rm", "-rf", "/"]]) {
			expect(await storeSecretValue(env, id, "i1", "u1", PASSWORD, { approvedCommand: wrong }), wrong.join(" ")).toBe(false);
		}
		expect(row(id)).toMatchObject({ status: "pending", has_secret: 0 });
	});

	it("approving exactly the stored command stores the value, marks the approval, and leaves the command as created", async () => {
		const id = await readyRequest();
		expect(row(id)).toMatchObject({ status: "ready", has_secret: 1, command: JSON.stringify(PMSET) });
		expect(row(id).command_approved_at).toBeTruthy();
		expect(await getSecureInputStatus(env, id, "i1", "u1")).toMatchObject({ status: "ready", command: PMSET, commandApproved: true, length: PASSWORD.length });
	});

	it("a value cannot be stored twice, so an approved command cannot be swapped under a stored password", async () => {
		const id = await readyRequest();
		expect(await storeSecretValue(env, id, "i1", "u1", "another-password", { approvedCommand: ["rm", "-rf", "/"] })).toBe(false);
		expect(row(id).command).toBe(JSON.stringify(PMSET));
	});

	it("approval is a rule about sudo requests only: every other scope is stored as it always was", async () => {
		const id = await createSecureInputRequest(env, { instanceId: "i1", userId: "u1", label: "code", destinationScope: "tmux" });
		expect(await storeSecretValue(env, id, "i1", "u1", "123456")).toBe(true);
		expect(row(id)).toMatchObject({ status: "ready", command: null, command_approved_at: null });
	});

	it("commandApproved compares element for element", () => {
		expect(commandApproved(JSON.stringify(PMSET), PMSET)).toBe(true);
		expect(commandApproved(JSON.stringify(PMSET), undefined)).toBe(false);
		expect(commandApproved(null, PMSET)).toBe(false);
		expect(commandApproved("not json", PMSET)).toBe(false);
	});
});

describe("validateSudoCommand and commandLine", () => {
	it("accepts argv, and refuses what is not one command", () => {
		expect(validateSudoCommand(PMSET)).toEqual({ ok: true, argv: PMSET });
		for (const bad of [undefined, null, "pmset -a autorestart 1", [], [""], ["pmset", 1], ["a\nb"], ["a\u0000b"], ["sudo", "x"], ["-u", "root", "id"], Array.from({ length: 40 }, () => "x"), ["x".repeat(3000)]]) {
			expect(validateSudoCommand(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
		}
	});

	it("shows the command as the owner reads it, quoting what needs it", () => {
		expect(commandLine(PMSET)).toBe("sudo -- pmset -a autorestart 1");
		expect(commandLine(["sh", "-c", "echo $HOME; id"])).toBe("sudo -- sh -c 'echo $HOME; id'");
		expect(commandLine(["echo", "it's"])).toBe("sudo -- echo 'it'\\''s'");
	});
});

describe("delivery: the runner is handed the approved argv and the value, and nothing else is touched", () => {
	it("exit 0 is delivered: the secret is spent, the output comes back, and the runner was called once on /secure/sudo", async () => {
		const id = await readyRequest();
		runnerSays({ ok: true, exitCode: 0, signal: null, timedOut: false, stdout: "autorestart 1\n", stderr: "" });
		const out = await deliver(id);
		expect(out).toMatchObject({ delivered: true, consumedValue: true, status: "consumed", exitCode: 0, command: PMSET, commandLine: "sudo -- pmset -a autorestart 1", stdout: "autorestart 1\n" });
		expect(out?.reason).toBeUndefined();
		expect(row(id)).toMatchObject({ status: "consumed", has_secret: 0 });
		expect(callRunner).toHaveBeenCalledTimes(1);
		const [, path, body] = callRunner.mock.calls[0] as [unknown, string, { command: string[]; value: string; timeoutMs: number }];
		expect(path).toBe("/secure/sudo");
		expect(body.command).toEqual(PMSET); // the stored, approved argv — the caller supplied none
		expect(body.value).toBe(PASSWORD); // the one place the value goes
	});

	it("NEVER types: no tmux, terminal or /secure/type path is called, on success or failure", async () => {
		for (const answer of [{ ok: true, exitCode: 0 }, { ok: false, exitCode: 1, stderr: "Sorry, try again." }]) {
			const id = await readyRequest();
			callRunner.mockReset();
			runnerSays(answer);
			await deliver(id);
			const paths = callRunner.mock.calls.map((c) => c[1] as string);
			expect(paths).toEqual(["/secure/sudo"]);
			expect(paths.some((p) => /^\/(tmux|terminal)\//.test(p) || p === "/secure/type" || p === "/secure/scrub")).toBe(false);
		}
	});

	it("the delivery takes no command from its caller: only the request's own approved one can run", async () => {
		const id = await readyRequest(["launchctl", "list"]);
		runnerSays({ ok: true, exitCode: 0 });
		// @ts-expect-error — the input type has no `command`; a caller that adds one is ignored at runtime too
		await runSecureInputSudo(env, { instanceId: "i1", userId: "u1", requestId: id, command: ["rm", "-rf", "/"] });
		expect(sudoCalls()[0][2]).toMatchObject({ command: ["launchctl", "list"] });
	});

	it("the runner is waited on for longer than it lets the command run, so its answer is the one that arrives", async () => {
		const id = await readyRequest();
		runnerSays({ ok: true, exitCode: 0 });
		await deliver(id);
		const body = callRunner.mock.calls[0][2] as { timeoutMs: number };
		const opts = callRunner.mock.calls[0][3] as { timeoutMs: number };
		expect(opts.timeoutMs).toBeGreaterThan(body.timeoutMs);
	});
});

describe("failure leaves the secret READY, says why, and is never retried", () => {
	const stillReady = (id: string) => expect(row(id)).toMatchObject({ status: "ready", has_secret: 1 });

	it("a WRONG PASSWORD: not delivered, sudo's words come back, the value is put back — and sudo was tried once", async () => {
		const id = await readyRequest();
		runnerSays({ ok: false, exitCode: 1, stderr: "Sorry, try again.\nsudo: no password was provided\nsudo: 1 incorrect password attempt\n", stdout: "", timedOut: false });
		const out = await deliver(id);
		expect(out).toMatchObject({ delivered: false, consumedValue: false, status: "ready", exitCode: 1 });
		expect(out?.reason).toContain("sudo exited 1");
		expect(out?.reason).toContain("sudo: 1 incorrect password attempt");
		expect(out?.reason).toMatch(/counted one incorrect attempt/);
		expect(out?.reason).toMatch(/value was NOT consumed and is still ready/);
		expect(out?.reason).toMatch(/Nothing is retried automatically/);
		stillReady(id);
		expect(callRunner).toHaveBeenCalledTimes(1); // no automatic second attempt
	});

	it("a command sudo's POLICY does not allow: not delivered, the reason is sudo's, and a retry is said not to help", async () => {
		const id = await readyRequest(["rm", "-rf", "/"]);
		runnerSays({ ok: false, exitCode: 1, stderr: "Sorry, user serge is not allowed to execute '/bin/rm -rf /' as root on mini.local.\n", stdout: "" });
		const out = await deliver(id);
		expect(out).toMatchObject({ delivered: false, consumedValue: false, status: "ready" });
		expect(out?.reason).toMatch(/not allowed to execute/);
		expect(out?.reason).toMatch(/a retry will not help/);
		stillReady(id);
		expect(callRunner).toHaveBeenCalledTimes(1);
	});

	it("the command failing on its own (non-zero exit, password fine) is not delivered either, with its stderr", async () => {
		const id = await readyRequest();
		runnerSays({ ok: false, exitCode: 64, stderr: "pmset: Usage error", stdout: "" });
		const out = await deliver(id);
		expect(out).toMatchObject({ delivered: false, status: "ready", exitCode: 64 });
		expect(out?.reason).toContain("pmset: Usage error");
		stillReady(id);
	});

	it("a command that outlives its deadline is not success: the secret is put back and the doubt is said", async () => {
		const id = await readyRequest();
		runnerSays({ ok: false, exitCode: null, signal: "SIGKILL", timedOut: true, stderr: "", stdout: "" });
		const out = await deliver(id);
		expect(out).toMatchObject({ delivered: false, consumedValue: false, status: "ready", timedOut: true });
		expect(out?.reason).toMatch(/may have partly run/);
		stillReady(id);
	});

	it("`ok: true` with a non-zero exit code is NOT trusted: only exit 0 delivers", async () => {
		const id = await readyRequest();
		runnerSays({ ok: true, exitCode: 1 });
		expect((await deliver(id))?.delivered).toBe(false);
		stillReady(id);
	});

	it("no sudo on the machine: said plainly, secret put back", async () => {
		const id = await readyRequest();
		runnerSays({ ok: false, exitCode: null, spawnError: "`sudo` is not installed on this machine." });
		const out = await deliver(id);
		expect(out?.reason).toContain("`sudo` is not installed on this machine.");
		stillReady(id);
	});

	it("a runner too old to know the route: the upgrade is named for the machine, nothing falls back to typing, secret put back", async () => {
		const id = await readyRequest();
		callRunner.mockRejectedValue(new Error("Runner /secure/sudo → 404: Not found"));
		const out = await deliver(id);
		expect(out).toMatchObject({ delivered: false, status: "ready" });
		expect(out?.reason).toContain(`\`mini\` cannot run a command under sudo with the password on stdin — it needs CLI ${SECURE_SUDO_MIN_CLI} or newer`);
		expect(callRunner.mock.calls.map((c) => c[1])).toEqual(["/secure/sudo"]); // no /secure/type fallback
		stillReady(id);
	});

	it("a runner that could not be reached: sudo was never started, and it is said so", async () => {
		const id = await readyRequest();
		callRunner.mockRejectedValue(new RunnerUnreachableError(`Runner relay is connected but not responding${runnerErrorTag("UNRESPONSIVE", true, "/secure/sudo")}`, { code: "UNRESPONSIVE", dispatched: false, path: "/secure/sudo" }));
		const out = await deliver(id);
		expect(out?.reason).toMatch(/could not be reached, so sudo was never started/);
		stillReady(id);
		expect(callRunner).toHaveBeenCalledTimes(1); // the platform does not try again by itself
	});

	it("a runner that dropped with the command in flight: the doubt is said — it may have used a password attempt — and the secret is put back", async () => {
		const id = await readyRequest();
		callRunner.mockRejectedValue(new RunnerUnreachableError(`Runner disconnected${runnerErrorTag("DROPPED", true, "/secure/sudo")}`, { code: "DROPPED", dispatched: true, path: "/secure/sudo" }));
		const out = await deliver(id);
		expect(out?.reason).toMatch(/not known whether sudo ran the command or used a password attempt/);
		stillReady(id);
		expect(callRunner).toHaveBeenCalledTimes(1);
	});

	it("after a failure the same request can be delivered again by a NEW call, and succeeds if sudo now exits 0", async () => {
		const id = await readyRequest();
		runnerSays({ ok: false, exitCode: 1, stderr: "sudo: a password is required" });
		expect((await deliver(id))?.delivered).toBe(false);
		runnerSays({ ok: true, exitCode: 0 });
		expect(await deliver(id)).toMatchObject({ delivered: true, status: "consumed" });
		expect(callRunner).toHaveBeenCalledTimes(2); // two calls by a caller; none by the platform on its own
	});
});

describe("refused before anything is spent", () => {
	const untouched = (id: string, status: string, hasSecret: number) => expect(row(id)).toMatchObject({ status, has_secret: hasSecret });

	it("a request still pending (the owner has not approved and entered it)", async () => {
		const id = await createSecureInputRequest(env, { instanceId: "i1", userId: "u1", label: "sudo", destinationScope: "sudo", command: PMSET });
		const out = await deliver(id);
		expect(out).toMatchObject({ delivered: false, consumedValue: false, status: "pending" });
		expect(out?.reason).toMatch(/owner has not entered the value and approved the command yet/);
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("a ready request whose command was never approved (a row not written by this code) is refused, not run", async () => {
		const id = await readyRequest();
		d1.exec(`UPDATE secure_input_requests SET command_approved_at = NULL WHERE id = '${id}'`);
		const out = await deliver(id);
		expect(out?.reason).toMatch(/owner has not approved this command/);
		expect(callRunner).not.toHaveBeenCalled();
		untouched(id, "ready", 1);
	});

	it("a request for another scope is refused and points at the right tool", async () => {
		const id = await createSecureInputRequest(env, { instanceId: "i1", userId: "u1", label: "code", destinationScope: "tmux" });
		await storeSecretValue(env, id, "i1", "u1", "123456");
		const out = await deliver(id);
		expect(out?.reason).toMatch(/for tmux, and secure_input_sudo delivers `sudo` requests only/);
		expect(callRunner).not.toHaveBeenCalled();
		untouched(id, "ready", 1);
	});

	it("no runner connected: nothing is consumed", async () => {
		const id = await readyRequest();
		getBoundRunnerConn.mockResolvedValue(null);
		const out = await deliver(id);
		expect(out?.reason).toMatch(/No runner is connected/);
		expect(callRunner).not.toHaveBeenCalled();
		untouched(id, "ready", 1);
	});

	it("already delivered: a spent request is not run a second time", async () => {
		const id = await readyRequest();
		runnerSays({ ok: true, exitCode: 0 });
		await deliver(id);
		callRunner.mockClear();
		const again = await deliver(id);
		expect(again).toMatchObject({ delivered: false, status: "consumed" });
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("another account, or another instance, finds nothing", async () => {
		const id = await readyRequest();
		expect(await runSecureInputSudo(env, { instanceId: "i1", userId: "u2", requestId: id })).toBeNull();
		expect(await runSecureInputSudo(env, { instanceId: "other", userId: "u1", requestId: id })).toBeNull();
		expect(await runSecureInputSudo(env, { instanceId: "i1", userId: "u1", requestId: "nope" })).toBeNull();
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("two calls at once make ONE sudo attempt: the claim lets one through and the other is told the value is gone", async () => {
		const id = await readyRequest();
		callRunner.mockImplementation(async () => {
			await new Promise((r) => setTimeout(r, 10));
			return { ok: true, exitCode: 0 };
		});
		const [a, b] = await Promise.all([deliver(id), deliver(id)]);
		expect([a?.delivered, b?.delivered].sort()).toEqual([false, true]);
		expect(callRunner).toHaveBeenCalledTimes(1);
		expect([a, b].find((r) => !r?.delivered)?.reason).toMatch(/could not be claimed|not ready/);
	});
});

describe("the value never leaves through anything but the runner call", () => {
	/** Every outcome, once, with the value planted in every place a careless implementation could echo it. */
	const outcomes: Array<[string, () => void]> = [
		["success that prints the password", () => runnerSays({ ok: true, exitCode: 0, stdout: `pw is ${PASSWORD}`, stderr: `debug ${PASSWORD}` })],
		["wrong password echoed by sudo", () => runnerSays({ ok: false, exitCode: 1, stdout: "", stderr: `Sorry, try again. (${PASSWORD})\n` })],
		["a policy refusal echoing it", () => runnerSays({ ok: false, exitCode: 1, stderr: `${PASSWORD} is not allowed to execute` })],
		["a runner error that quotes it", () => callRunner.mockRejectedValue(new Error(`Runner /secure/sudo → 500: failed with ${PASSWORD} in the body`))],
		["a runner that dropped, quoting it", () => callRunner.mockRejectedValue(new RunnerUnreachableError(`dropped ${PASSWORD}${runnerErrorTag("DROPPED", true, "/secure/sudo")}`, { code: "DROPPED", dispatched: true }))],
		["a timeout with output that has it", () => runnerSays({ ok: false, exitCode: null, timedOut: true, stdout: PASSWORD, stderr: PASSWORD })],
	];

	it.each(outcomes)("%s: not in the result, a log line, the console or an error record", async (_name, plant) => {
		const id = await readyRequest();
		plant();
		const out = await deliver(id);
		const everything = [JSON.stringify(out), ...observed, JSON.stringify(logError.mock.calls)].join("\n");
		expect(everything).not.toContain(PASSWORD);
		// …and whatever else sudo said survives, with the value in its place.
		expect(JSON.stringify(out)).toMatch(/redacted|exited|did not|was NOT consumed/);
	});

	it("the status the owner and the agent read never holds the value, only its length", async () => {
		const id = await readyRequest();
		const view = JSON.stringify(await getSecureInputStatus(env, id, "i1", "u1"));
		expect(view).not.toContain(PASSWORD);
		expect(view).toContain(`"length":${PASSWORD.length}`);
	});

	it("at rest the value is ciphertext, and the failure path puts back ciphertext, not the plain value", async () => {
		const id = await readyRequest();
		runnerSays({ ok: false, exitCode: 1, stderr: "Sorry, try again." });
		await deliver(id);
		const stored = d1.sqlite.prepare("SELECT secret_ciphertext, dek_wrapped, iv FROM secure_input_requests WHERE id = ?").get(id) as Record<string, Uint8Array>;
		for (const col of Object.values(stored)) expect(Buffer.from(col).toString("latin1")).not.toContain(PASSWORD);
	});
});
