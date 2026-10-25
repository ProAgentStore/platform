/**
 * #1196 — typed text never rides a process's argv, on any runner path.
 *
 * `node:child_process` is mocked, so no process is spawned. Every call is recorded with its argv and stdin apart, and the
 * assertions are the two halves of the promise: the secret is in NO argument list (and in no thrown message), and the text
 * still arrives — on stdin — with the Enter / no-Enter behaviour each path always had.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { calls, behave } = vi.hoisted(() => ({ calls: [] as Array<{ file: string; args: string[]; input?: string }>, behave: { fail: (_c: { file: string; args: string[] }) => false as boolean } }));
vi.mock("node:child_process", async (orig) => {
	const real = await orig<typeof import("node:child_process")>();
	const record = (file: string, args: string[] = [], opts: { input?: string } = {}) => {
		calls.push({ file, args: [...args], input: opts?.input });
		// A failing command's message quotes its argv, as the real one does.
		if (behave.fail({ file, args })) throw new Error(`Command failed: ${file} ${args.join(" ")}`);
		return "";
	};
	return { ...real, execFileSync: vi.fn(record), execFile: vi.fn(record) };
});

const tmux = await import("./tmux.js");
const terminal = await import("./terminal.js");
const { machineSecureTypeDeps, secureType } = await import("./secure-type.js");
const { appleString } = await import("./apple-script.js");

const SECRETS = {
	jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abc123",
	ghp: `ghp_${"X".repeat(40)}`,
	password: 'p@ss"wor\\d🔑',
};
const argvText = () => calls.map((c) => `${c.file} ${c.args.join(" ")}`).join("\n");
const inputs = () => calls.map((c) => c.input ?? "");
const named = (file: string, first: string) => calls.filter((c) => c.file === file && c.args[0] === first);

beforeEach(() => {
	calls.length = 0;
	behave.fail = () => false;
});

describe("no secret-shaped value reaches any argv", () => {
	for (const [label, secret] of Object.entries(SECRETS)) {
		describe(label, () => {
			it("tmux sendText", () => {
				tmux.sendText("main", secret);
				expect(argvText()).not.toContain(secret);
				expect(inputs()).toContain(secret);
			});
			it("tmux runCommand", () => {
				tmux.runCommand("main", `echo ${secret}`);
				expect(argvText()).not.toContain(secret);
				expect(inputs()).toContain(`echo ${secret}`);
			});
			it("kitty sendTerminalKeys", () => {
				terminal.sendTerminalKeys("kitty:7", { text: secret });
				expect(argvText()).not.toContain(secret);
				expect(inputs()).toContain(secret);
			});
			it("kitty runTerminalCommand", () => {
				terminal.runTerminalCommand("kitty:7", `login ${secret}`);
				expect(argvText()).not.toContain(secret);
				expect(inputs()).toContain(`login ${secret}`);
			});
			it("iTerm2 sendTerminalKeys", () => {
				terminal.sendTerminalKeys("iterm2:1:1:1", { text: secret });
				expect(argvText()).not.toContain(secret);
				expect(calls.some((c) => c.file === "osascript" && c.input?.includes("write text"))).toBe(true);
			});
			it("iTerm2 runTerminalCommand", () => {
				terminal.runTerminalCommand("iterm2:1:1:1", `login ${secret}`);
				expect(argvText()).not.toContain(secret);
			});
			it("/secure/type to an iTerm2 target", async () => {
				await secureType({ target: "iterm2:1:1:1", value: secret }, await machineSecureTypeDeps());
				expect(argvText()).not.toContain(secret);
				expect(argvText()).not.toContain(appleString(secret));
			});
			it("a FAILING command's thrown message does not carry it either", () => {
				behave.fail = () => true;
				for (const run of [
					() => tmux.sendText("main", secret),
					() => terminal.sendTerminalKeys("kitty:7", { text: secret }),
					() => terminal.sendTerminalKeys("iterm2:1:1:1", { text: secret }),
				]) {
					let message = "";
					try {
						run();
					} catch (e) {
						message = e instanceof Error ? e.message : String(e);
					}
					expect(message).not.toContain(secret);
				}
			});
		});
	}
});

describe("behaviour is compatible", () => {
	it("tmux sendText: stdin into a one-use buffer, pasted raw (-r, LF stays LF) and deleted (-d), no Enter", () => {
		tmux.sendText("main", "hello world");
		const load = named("tmux", "load-buffer")[0];
		const paste = named("tmux", "paste-buffer")[0];
		expect(load.input).toBe("hello world");
		const buffer = load.args[2];
		expect(load.args).toEqual(["load-buffer", "-b", buffer, "-"]);
		expect(buffer).toMatch(/^pags-type-/);
		expect(paste.args).toEqual(["paste-buffer", "-d", "-r", "-b", buffer, "-t", "main"]);
		expect(calls.some((c) => c.args.includes("send-keys"))).toBe(false);
	});

	it("tmux sendText: empty text does nothing; single characters and newlines go the same way", () => {
		tmux.sendText("main", "");
		expect(calls).toEqual([]);
		tmux.sendText("main", "y");
		tmux.sendText("main", "a\nb\tc");
		expect(named("tmux", "load-buffer").map((c) => c.input)).toEqual(["y", "a\nb\tc"]);
	});

	it("tmux runCommand: the text, THEN a separate send-keys Enter", () => {
		tmux.runCommand("main", "ls -la");
		const order = calls.map((c) => c.args[0]);
		expect(order.indexOf("paste-buffer")).toBeLessThan(order.indexOf("send-keys"));
		expect(calls.find((c) => c.args[0] === "send-keys")?.args).toEqual(["send-keys", "-t", "main", "Enter"]);
	});

	it("tmux: the buffer is deleted even when paste-buffer throws, and the error names no text", () => {
		behave.fail = ({ args }) => args[0] === "paste-buffer";
		expect(() => tmux.sendText("main", "topsecret-value")).toThrow();
		expect(named("tmux", "delete-buffer")).toHaveLength(1);
		const buffer = named("tmux", "load-buffer")[0].args[2];
		expect(named("tmux", "delete-buffer")[0].args).toEqual(["delete-buffer", "-b", buffer]);
	});

	it("a 10KB payload (Unicode included) arrives whole, on stdin only", () => {
		const big = `${"line é🔑 0123456789\n".repeat(600)}END`.slice(0, 10_240);
		tmux.sendText("main", big);
		terminal.sendTerminalKeys("kitty:7", { text: big });
		expect(named("tmux", "load-buffer")[0].input).toBe(big);
		expect(calls.find((c) => c.file === "kitty")?.input).toBe(big);
		expect(argvText()).not.toContain(big.slice(0, 200));
	});

	it("kitty: send-text --stdin with the text; run adds a separate Enter key; plain send adds none", () => {
		terminal.sendTerminalKeys("kitty:7", { text: "abc" });
		expect(calls[0]).toMatchObject({ file: "kitty", args: ["@", "send-text", "--match", "id:7", "--stdin"], input: "abc" });
		expect(calls.some((c) => c.args.includes("send-key"))).toBe(false);
		calls.length = 0;
		terminal.runTerminalCommand("kitty:7", "make");
		expect(calls.map((c) => c.args[1]).filter((a) => a !== "get-text")).toEqual(["send-text", "send-key"]);
		expect(calls[1].args).toEqual(["@", "send-key", "--match", "id:7", "enter"]);
		calls.length = 0;
		terminal.sendTerminalKeys("kitty:7", { keys: ["Enter"] });
		expect(calls.map((c) => c.args).filter((a) => a[1] !== "get-text")).toEqual([["@", "send-key", "--match", "id:7", "enter"]]);
	});

	it("iTerm2: `osascript -` is the only argv; send/run write text with Return as before, /secure/type does not", async () => {
		terminal.sendTerminalKeys("iterm2:2:3:4", { text: "hi" });
		const osa = calls.filter((c) => c.file === "osascript");
		expect(osa[0].args).toEqual(["-"]);
		expect(osa[0].input).toContain("session 4 of tab 3 of window 2");
		expect(osa[0].input).toContain('write text "hi"');
		expect(osa[0].input).not.toContain("newline NO");
		calls.length = 0;
		await secureType({ target: "iterm2:2:3:4", value: "pw" }, await machineSecureTypeDeps());
		const secure = calls.find((c) => c.file === "osascript" && c.input?.includes("write text"));
		expect(secure?.args).toEqual(["-"]);
		expect(secure?.input).toContain('write text "pw" newline NO');
	});

	it("iTerm2 keys (#1144): Enter, C-u and C-c are typed as their control characters, never as Return-adding text", () => {
		terminal.sendTerminalKeys("iterm2:1:2:3", { keys: ["C-u"] });
		terminal.sendTerminalKeys("iterm2:1:2:3", { keys: ["C-c", "Enter"] });
		terminal.sendTerminalKeys("iterm2:1:2:3", { text: "ls", keys: ["Enter"] });
		const osa = calls.filter((c) => c.file === "osascript" && c.input?.includes("write text")).map((c) => c.input ?? "");
		expect(osa[0]).toContain("session 3 of tab 2 of window 1");
		expect(osa[0]).toContain("write text (ASCII character 21) newline NO");
		expect(osa[1]).toContain("write text (ASCII character 3) newline NO");
		expect(osa[1]).toContain("write text (ASCII character 13) newline NO");
		// Text alongside keys is typed WITHOUT Return; the key supplies it.
		expect(osa[2]).toContain('write text "ls" newline NO');
		expect(osa[2].indexOf('"ls"')).toBeLessThan(osa[2].indexOf("ASCII character 13"));
	});

	it("iTerm2 refuses a key it cannot type as a character, naming it", () => {
		expect(() => terminal.sendTerminalKeys("iterm2:1:1:1", { keys: ["Up"] })).toThrow(/cannot send the key "Up"/);
		expect(() => terminal.sendTerminalKeys("iterm2:1:1:1", { keys: ["C-u", "F5"] })).toThrow(/"F5"/);
		// Nothing was sent for the refused call — the check precedes the script.
		expect(calls.filter((c) => c.file === "osascript" && c.input?.includes("write text"))).toEqual([]);
	});

	it("appleString is exact for quotes, backslashes, newlines, control characters and Unicode", () => {
		expect(appleString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
		expect(appleString("é🔑")).toBe('"é🔑"');
		expect(appleString("a\u001bb")).toBe('"a" & (ASCII character 27) & "b"');
		expect(appleString("")).toBe('""');
	});
});

describe("every iTerm2 script goes over stdin", () => {
	it("even a launch command is not in argv", () => {
		terminal.createTerminalTarget({ backend: "iterm2", workDir: "/tmp", command: "export TOKEN=abc123xyz" });
		expect(argvText()).not.toContain("abc123xyz");
		expect(calls.every((c) => c.file !== "osascript" || (c.args.length === 1 && c.args[0] === "-"))).toBe(true);
	});
});
