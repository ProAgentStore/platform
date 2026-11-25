import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { commandInvocation, shimInvocation } from "./portable-command.mjs";

describe("portable hook commands (#1647)", () => {
	it("executes a Corepack entry in a spaced Unicode path with literal arguments", () => {
		const root = mkdtempSync(join(tmpdir(), "pags tools café "));
		try {
			const entry = join(root, "node_modules/corepack/dist/pnpm.js");
			mkdirSync(join(root, "node_modules/corepack/dist"), { recursive: true });
			writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exitCode = 7;");
			const args = ["exec", "a b", "a&echo injected", "$(echo injected)", 'a"b', "尾"];
			const [command, argv] = commandInvocation("pnpm", args, { platform: "win32", env: { PATH: root } });
			const result = spawnSync(command, argv, { encoding: "utf8" });
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(7);
			expect(JSON.parse(result.stdout)).toEqual(args);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the inherited pnpm entry, never an unrelated npm entry", () => {
		const args = ["exec", "tsc"];
		expect(commandInvocation("pnpm", args, { platform: "win32", node: "node", env: { npm_execpath: "C:/tools/pnpm.cjs" }, exists: (p) => p === "C:/tools/pnpm.cjs" })).toEqual(["node", ["C:/tools/pnpm.cjs", ...args]]);
		expect(() => commandInvocation("pnpm", args, { platform: "win32", env: { npm_execpath: "C:/tools/npm-cli.js" }, exists: () => false })).toThrow(/Cannot locate/);
	});

	it("supports native pnpm and keeps POSIX commands unchanged", () => {
		const args = ["test"];
		const native = join("tools", "pnpm.exe");
		expect(commandInvocation("pnpm", args, { platform: "win32", env: { PATH: "tools" }, exists: (p) => p === native })).toEqual([native, args]);
		expect(commandInvocation("pnpm", args, { platform: "linux" })).toEqual(["pnpm", args]);
		expect(commandInvocation("node", args)).toEqual([process.execPath, args]);
	});
});

describe("tools installed as Windows shims (#1725)", () => {
	const dir = "C:\\Users\\Dev Person\\bin";
	const env = { Path: `C:\\Windows;${dir}`, ComSpec: "C:\\Windows\\system32\\cmd.exe" };
	const has = (...files) => (p) => files.includes(p);

	it("a .cmd found through PATHEXT runs through cmd.exe with every argument quoted", () => {
		const r = shimInvocation("npm", ["view", "a b@1", "version"], { platform: "win32", env, exists: has(win32.join(dir, "npm.cmd")) });
		expect(r.file).toBe("C:\\Windows\\system32\\cmd.exe");
		expect(r.windowsVerbatimArguments).toBe(true);
		expect(r.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
		expect(r.args[3]).toContain("npm.cmd");
		expect(r.args[3]).toContain("a^^^ b@1"); // the spaced argument is escaped for cmd.exe, never bare
	});

	it("a real executable is run as itself, ahead of a .cmd beside it", () => {
		const exe = win32.join(dir, "gh.exe");
		expect(shimInvocation("gh", ["api", "/x"], { platform: "win32", env, exists: has(exe, win32.join(dir, "gh.cmd")) })).toEqual({ file: exe, args: ["api", "/x"] });
	});

	it("nothing found, or not Windows: the bare name, so a missing tool fails as it did", () => {
		expect(shimInvocation("npm", ["x"], { platform: "win32", env, exists: () => false })).toEqual({ file: "npm", args: ["x"] });
		expect(shimInvocation("npm", ["x"], { platform: "linux" })).toEqual({ file: "npm", args: ["x"] });
	});
});
