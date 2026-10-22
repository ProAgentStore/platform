/**
 * #1143 — a secret typed by `secure_input_inject` never appears in any process's argv.
 *
 * `tmux send-keys -l <value>` and `kitty @ send-text … <value>` put the plaintext in a child's argv, where
 * `ps` and `/proc/<pid>/cmdline` show it to any local user. Every command `/secure/type` runs is recorded
 * here, argv and stdin apart: the value may be on STDIN, and in no argument list, ever.
 */
import { describe, expect, it } from "vitest";
import { secureType, type SecureTypeDeps } from "./secure-type.js";

const SECRET = "hunter2-Correct-Horse-Battery";

function machine(over: { fail?: (file: string, args: string[]) => boolean; sessions?: string[] } = {}) {
	const calls: Array<{ file: string; args: string[]; input: string }> = [];
	let typed = "";
	const deps: SecureTypeDeps = {
		exec: (file, args, opts) => {
			calls.push({ file, args: [...args], input: opts.input });
			if (over.fail?.(file, args)) throw new Error(`Command failed: ${file} ${args.join(" ")}`);
			if (args.includes("load-buffer") || args.includes("--stdin")) typed += opts.input;
			return "";
		},
		exists: (s) => (over.sessions ?? ["gcloud", "main"]).includes(s),
		capture: () => `$ prompt: ${typed}`,
		settle: async () => `$ prompt: ${typed}`,
	};
	return { deps, calls, typed: () => typed };
}

const argvOf = (calls: Array<{ args: string[] }>) => calls.flatMap((c) => c.args);

describe("/secure/type delivers without argv (#1143)", () => {
	it("tmux: load-buffer from stdin into a one-use named buffer, then paste-buffer -d — the value on stdin only", async () => {
		const m = machine();
		const out = await secureType({ target: "gcloud", value: SECRET }, m.deps);
		expect(argvOf(m.calls).some((a) => a.includes(SECRET))).toBe(false);
		const [load, paste] = m.calls;
		expect(load).toMatchObject({ file: "tmux", input: SECRET });
		expect(load.args.slice(0, 2)).toEqual(["load-buffer", "-b"]);
		expect(load.args.at(-1)).toBe("-");
		const buffer = load.args[2];
		expect(buffer).toMatch(/^pags-secure-/);
		expect(paste.args).toEqual(["paste-buffer", "-d", "-b", buffer, "-t", "gcloud"]);
		// The buffer is deleted even after a paste that ran (`-d`), so nothing named lingers.
		expect(m.calls.some((c) => c.args[0] === "delete-buffer" && c.args.includes(buffer))).toBe(true);
		expect(out).toMatchObject({ target: "gcloud", changed: true });
	});

	it("a `tmux:` target is the same tmux session", async () => {
		const m = machine();
		await secureType({ target: "tmux:main", value: SECRET }, m.deps);
		expect(m.calls[1].args).toContain("main");
		expect(argvOf(m.calls).some((a) => a.includes(SECRET))).toBe(false);
	});

	it("kitty: send-text --stdin — the value on stdin only", async () => {
		const m = machine();
		await secureType({ target: "kitty:3", value: SECRET }, m.deps);
		expect(m.calls).toEqual([{ file: "kitty", args: ["@", "send-text", "--match", "id:3", "--stdin"], input: SECRET }]);
	});

	it("a failing paste still deletes the buffer, and its error names the session — never the value", async () => {
		const m = machine({ fail: (_f, args) => args[0] === "paste-buffer" });
		const err = await secureType({ target: "gcloud", value: SECRET }, m.deps).then(() => null, (e) => e as Error);
		expect(err?.message).toMatch(/gcloud/);
		expect(err?.message).not.toContain(SECRET);
		expect(m.calls.some((c) => c.args[0] === "delete-buffer")).toBe(true);
		expect(argvOf(m.calls).some((a) => a.includes(SECRET))).toBe(false);
	});

	it("a failing kitty call's error does not carry the value either", async () => {
		const m = machine({ fail: (f) => f === "kitty" });
		const err = await secureType({ target: "kitty:3", value: SECRET }, m.deps).then(() => null, (e) => e as Error);
		expect(err?.message).not.toContain(SECRET);
	});

	it("refuses a missing session and an empty value — before running anything", async () => {
		for (const [body, msg] of [
			[{ target: "nope", value: SECRET }, /No tmux session/],
			[{ target: "gcloud", value: "" }, /Nothing to type/],
		] as const) {
			const m = machine();
			await expect(secureType(body, m.deps)).rejects.toThrow(msg);
			expect(m.calls).toEqual([]);
		}
	});
});
