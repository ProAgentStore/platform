/**
 * #1131 — an owner-approved command under `sudo -S`, the password on STDIN and nowhere else.
 *
 * `node:child_process` is faked, so no process is started and no real password exists. Every `spawn` is recorded with its file, argv,
 * environment and every byte written to its stdin, and the assertions are the promises the owner's decision asked for: the value is in NO
 * argument list, NO environment, no thrown message and no returned field; it arrives on stdin once; tmux is never touched; success is the
 * exit code; and a failure is reported with the value cut out of sudo's own words — after exactly one attempt.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RunnerInputError } from "../errors.js";
import { approvedArgv, secureSudo, SUDO_DEFAULT_TIMEOUT_MS, SUDO_OUTPUT_KEEP, withoutValue, type SecureSudoDeps } from "./secure-sudo.js";

const PASSWORD = "hunter2-Sup3r!pw";

interface Seen {
	file: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	options: Record<string, unknown>;
	stdin: string[];
	stdinEnded: boolean;
	killed: string[];
}
type Script = { stdout?: string; stderr?: string; code?: number | null; signal?: string | null; error?: NodeJS.ErrnoException; hang?: boolean; closeStdinEarly?: boolean };

/** A `spawn` whose child behaves as scripted; `seen` is everything the module handed it. */
function fakeSpawn(script: Script = {}) {
	const seen: Seen[] = [];
	const spawn = vi.fn((file: string, args: string[], options: Record<string, unknown>) => {
		const entry: Seen = { file, args: [...args], env: { ...(options.env as NodeJS.ProcessEnv) }, options, stdin: [], stdinEnded: false, killed: [] };
		seen.push(entry);
		const child = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { end: (d: string) => void }; stdout: EventEmitter; stderr: EventEmitter; kill: (s: string) => void };
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		const stdin = new EventEmitter() as EventEmitter & { end: (d: string) => void };
		stdin.end = (d: string) => {
			entry.stdin.push(d);
			entry.stdinEnded = true;
			if (script.closeStdinEarly) stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
		};
		child.stdin = stdin;
		child.kill = (s: string) => {
			entry.killed.push(s);
			setTimeout(() => child.emit("close", null, s), 0);
		};
		setTimeout(() => {
			if (script.error) return child.emit("error", script.error);
			if (script.hang) return;
			if (script.stdout) child.stdout.emit("data", Buffer.from(script.stdout));
			if (script.stderr) child.stderr.emit("data", Buffer.from(script.stderr));
			child.emit("close", script.code === undefined ? 0 : script.code, script.signal ?? null);
		}, 0);
		return child;
	});
	return { spawn, seen, deps: { spawn } as unknown as SecureSudoDeps };
}

const PMSET = ["pmset", "-a", "autorestart", "1"];
const run = (script: Script, body: Record<string, unknown> = { command: PMSET, value: PASSWORD }) => {
	const f = fakeSpawn(script);
	return secureSudo(body, f.deps).then((result) => ({ result, ...f }));
};

describe("what is handed to the process", () => {
	it("starts `sudo -S -p '' -- <argv>` with NO shell: the command is an argv array after `--`", async () => {
		const { seen } = await run({});
		expect(seen).toHaveLength(1);
		expect(seen[0].file).toBe("sudo");
		expect(seen[0].args).toEqual(["-S", "-p", "", "--", ...PMSET]);
		expect(seen[0].options.shell).toBeUndefined(); // a shell would reinterpret every argument
	});

	it("writes the value to stdin — once, as one line, then closes it", async () => {
		const { seen } = await run({});
		expect(seen[0].stdin).toEqual([`${PASSWORD}\n`]);
		expect(seen[0].stdinEnded).toBe(true);
	});

	it("the value is in no argument and no environment variable — on success, wrong password or a refused command", async () => {
		for (const script of [{}, { code: 1, stderr: "Sorry, try again.\nsudo: 1 incorrect password attempt" }, { code: 1, stderr: "Sorry, user serge is not allowed to execute '/bin/rm' as root" }] as Script[]) {
			const { seen } = await run(script);
			for (const call of seen) {
				expect(call.args.join("\u0000")).not.toContain(PASSWORD);
				expect(Object.values(call.env).join("\u0000")).not.toContain(PASSWORD);
				expect(JSON.stringify(call.options.env ?? {})).not.toContain(PASSWORD);
			}
		}
	});

	it("an argument that merely looks like an option or a shell string stays ONE argument, after `--`", async () => {
		const tricky = ["sh", "-c", "echo $(id); rm -rf /tmp/x"];
		const { seen } = await run({}, { command: tricky, value: PASSWORD });
		expect(seen[0].args).toEqual(["-S", "-p", "", "--", ...tricky]);
	});

	it("never asks sudo to read its password from anywhere but stdin: no askpass in the environment", async () => {
		const before = process.env.SUDO_ASKPASS;
		process.env.SUDO_ASKPASS = "/tmp/evil-helper";
		try {
			const { seen } = await run({});
			expect(seen[0].env.SUDO_ASKPASS).toBeUndefined();
		} finally {
			if (before === undefined) delete process.env.SUDO_ASKPASS;
			else process.env.SUDO_ASKPASS = before;
		}
	});

	it("never touches tmux, a terminal or any other program: `sudo` is the only process", async () => {
		const { spawn } = await run({});
		expect(spawn.mock.calls.map((c) => c[0])).toEqual(["sudo"]);
	});
});

describe("success is sudo's exit code", () => {
	it("exit 0 is delivered, with the command's output", async () => {
		const { result } = await run({ code: 0, stdout: "autorestart 1\n" });
		expect(result).toMatchObject({ ok: true, exitCode: 0, timedOut: false, stdout: "autorestart 1\n", stderr: "" });
	});

	it("any other exit code is NOT delivered", async () => {
		for (const code of [1, 2, 126, 127]) expect((await run({ code })).result).toMatchObject({ ok: false, exitCode: code });
	});

	it("a signal is not success", async () => {
		expect((await run({ code: null, signal: "SIGKILL" })).result).toMatchObject({ ok: false, exitCode: null, signal: "SIGKILL" });
	});
});

describe("failure: one attempt, sudo's reason, the value cut out", () => {
	it("a wrong password is reported with sudo's own words, after exactly ONE attempt — never retried", async () => {
		const { result, spawn, seen } = await run({ code: 1, stderr: "Sorry, try again.\nsudo: no password was provided\nsudo: 1 incorrect password attempt\n" });
		expect(result).toMatchObject({ ok: false, exitCode: 1 });
		expect(result.stderr).toContain("sudo: 1 incorrect password attempt");
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(seen[0].stdin).toHaveLength(1); // the value was offered once
	});

	it("a command sudo's policy does not allow is reported as such, after one attempt", async () => {
		const { result, spawn } = await run({ code: 1, stderr: "Sorry, user serge is not allowed to execute '/bin/rm -rf /' as root on mini.local." }, { command: ["rm", "-rf", "/"], value: PASSWORD });
		expect(result).toMatchObject({ ok: false, exitCode: 1 });
		expect(result.stderr).toMatch(/not allowed to execute/);
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("if sudo or the command ECHOES the value, it is cut out of stdout and stderr", async () => {
		const { result } = await run({ code: 1, stdout: `you typed ${PASSWORD}`, stderr: `sudo: bad password ${PASSWORD}\nagain: ${PASSWORD}` });
		expect(JSON.stringify(result)).not.toContain(PASSWORD);
		expect(result.stderr).toBe("sudo: bad password [redacted]\nagain: [redacted]");
		expect(result.stdout).toBe("you typed [redacted]");
	});

	it("…and the value as pasted with a stray newline is cut out too", async () => {
		const { result, seen } = await run({ code: 1, stderr: `bad: ${PASSWORD}` }, { command: PMSET, value: `${PASSWORD}\n` });
		expect(seen[0].stdin).toEqual([`${PASSWORD}\n`]); // one line, the stray break not doubled
		expect(result.stderr).toBe("bad: [redacted]");
	});

	it("output is bounded to its tail, marked, and still free of the value", async () => {
		const noise = `${"x".repeat(SUDO_OUTPUT_KEEP * 2)}${PASSWORD}`;
		const { result } = await run({ code: 1, stderr: noise });
		expect(result.stderr.length).toBeLessThan(SUDO_OUTPUT_KEEP + 120);
		expect(result.stderr).toMatch(/^\[cut: showing the last 4000 of \d+ characters\]\n/);
		expect(result.stderr).not.toContain(PASSWORD);
	});

	it("no sudo on the machine is a plain refusal, not a crash", async () => {
		const { result } = await run({ error: Object.assign(new Error("spawn sudo ENOENT"), { code: "ENOENT" }) });
		expect(result).toMatchObject({ ok: false, exitCode: null, spawnError: "`sudo` is not installed on this machine." });
		expect(JSON.stringify(result)).not.toContain(PASSWORD);
	});

	it("sudo exiting before it reads stdin (a refused command) does not crash the write", async () => {
		const { result } = await run({ code: 1, stderr: "sudo: a terminal is required", closeStdinEarly: true });
		expect(result).toMatchObject({ ok: false, exitCode: 1 });
	});

	it("a command that never ends is stopped at the deadline, reported as timed out, and is not success", async () => {
		vi.useFakeTimers();
		try {
			const f = fakeSpawn({ hang: true });
			const pending = secureSudo({ command: PMSET, value: PASSWORD, timeoutMs: 5_000 }, f.deps);
			await vi.advanceTimersByTimeAsync(5_001);
			const result = await pending;
			expect(f.seen[0].killed).toEqual(["SIGKILL"]);
			expect(result).toMatchObject({ ok: false, timedOut: true });
			expect(f.spawn).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("the deadline can only be shortened by the caller, never lengthened", async () => {
		vi.useFakeTimers();
		try {
			const f = fakeSpawn({ hang: true });
			const pending = secureSudo({ command: PMSET, value: PASSWORD, timeoutMs: 10 * 60_000 }, f.deps);
			await vi.advanceTimersByTimeAsync(SUDO_DEFAULT_TIMEOUT_MS + 1);
			expect((await pending).timedOut).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("a malformed request is refused before any process exists", () => {
	const refused = async (body: Record<string, unknown>) => {
		const f = fakeSpawn();
		await expect(secureSudo(body, f.deps)).rejects.toBeInstanceOf(RunnerInputError);
		expect(f.spawn).not.toHaveBeenCalled();
	};

	it.each([
		["no command", { value: PASSWORD }],
		["an empty command", { command: [], value: PASSWORD }],
		["a command that is a string, not argv", { command: "pmset -a autorestart 1", value: PASSWORD }],
		["a non-string element", { command: ["pmset", 1], value: PASSWORD }],
		["an empty element", { command: ["pmset", ""], value: PASSWORD }],
		["a newline inside an argument", { command: ["pmset", "a\nb"], value: PASSWORD }],
		["a NUL inside an argument", { command: ["pmset", "a\u0000b"], value: PASSWORD }],
		["sudo as the program", { command: ["sudo", "pmset"], value: PASSWORD }],
		["an option as the program", { command: ["-u", "root", "id"], value: PASSWORD }],
		["too many elements", { command: Array.from({ length: 40 }, () => "x"), value: PASSWORD }],
		["no value", { command: PMSET }],
		["an empty value", { command: PMSET, value: "" }],
		["only line breaks as the value", { command: PMSET, value: "\n\n" }],
		["a multi-line value", { command: PMSET, value: "a\nb" }],
	])("%s", async (_name, body) => refused(body));

	it("a refusal names the problem and never the value", async () => {
		const f = fakeSpawn();
		const err = await secureSudo({ command: ["sudo"], value: PASSWORD }, f.deps).catch((e: Error) => e);
		expect((err as Error).message).not.toContain(PASSWORD);
	});
});

describe("approvedArgv and withoutValue", () => {
	it("approvedArgv returns the argv untouched", () => {
		expect(approvedArgv(PMSET)).toEqual(PMSET);
	});

	it("withoutValue cuts every occurrence and leaves other text", () => {
		expect(withoutValue(`a ${PASSWORD} b ${PASSWORD}`, PASSWORD)).toBe("a [redacted] b [redacted]");
		expect(withoutValue("nothing here", PASSWORD)).toBe("nothing here");
		expect(withoutValue("anything", "")).toBe("anything");
	});
});
