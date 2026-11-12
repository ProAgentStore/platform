import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commandInvocation } from "./portable-command.mjs";

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
