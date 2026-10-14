/**
 * #1006 / PAS #356 on the runner: a `pas mcp-auth exec -- <engine …>` preset SPAWNS the wrapper
 * (it supplies the PAS MCP credential to that process only) while the adapter, the turn/resume
 * argument builders and the engine-installed check all work on the engine after `--`.
 */
import { describe, expect, it } from "vitest";
import { codexEngineAdapter, engineAdapterFor, genericRawEngineAdapter } from "./engine-adapter.js";
import { checkEngine } from "./engine-check.js";
import { parseCommand } from "./headless.js";
import { spawnTarget, unwrapLauncher } from "./launcher-wrapper.js";

const unwrap = (cmd: string) => {
	const p = parseCommand(cmd);
	return unwrapLauncher(p.bin, p.args);
};

describe("unwrapLauncher", () => {
	it("pas mcp-auth exec -- codex exec … → prefix kept, engine codex with its own args", () => {
		expect(unwrap("pas mcp-auth exec -- codex exec --sandbox danger-full-access")).toEqual({ prefix: ["pas", "mcp-auth", "exec", "--"], bin: "codex", args: ["exec", "--sandbox", "danger-full-access"] });
	});

	it("keeps quoting: the engine's quoted arguments are intact after the wrapper", () => {
		expect(unwrap('pas mcp-auth exec -- codex --model o4-mini "do thing"').args).toEqual(["--model", "o4-mini", "do thing"]);
	});

	it("a plain command, and `pas` used any other way, are untouched", () => {
		expect(unwrap("codex exec")).toEqual({ prefix: [], bin: "codex", args: ["exec"] });
		expect(unwrap("pas something else")).toEqual({ prefix: [], bin: "pas", args: ["something", "else"] });
		expect(unwrap("pas mcp-auth exec --")).toEqual({ prefix: [], bin: "pas", args: ["mcp-auth", "exec", "--"] });
	});
});

describe("what the runner spawns and how it drives it", () => {
	it("the wrapper is what runs, carrying the engine and the args the adapter built", () => {
		const u = unwrap("pas mcp-auth exec -- codex exec --sandbox danger-full-access");
		const turn = engineAdapterFor("codex", u.args).buildTurnArgs(u.args, "fix the bug");
		const target = spawnTarget(u.prefix, u.bin, turn);
		expect(target.command).toBe("pas");
		expect(target.args.slice(0, 5)).toEqual(["mcp-auth", "exec", "--", "codex", "exec"]);
		expect(target.args).toContain("fix the bug");
		// Without a wrapper it is exactly the engine, as before.
		expect(spawnTarget([], "codex", ["exec"])).toEqual({ command: "codex", args: ["exec"] });
	});

	it("Codex's structured exec adapter is chosen through the wrapper — before the fix it fell back to raw", () => {
		expect(engineAdapterFor("codex", unwrap("pas mcp-auth exec -- codex exec").args)).toBe(codexEngineAdapter);
		const raw = parseCommand("pas mcp-auth exec -- codex exec");
		expect(engineAdapterFor("codex", raw.args)).toBe(genericRawEngineAdapter);
	});

	it("the installed check looks for the ENGINE, not the wrapper", () => {
		const seen: string[] = [];
		checkEngine({ clientType: "codex", command: "pas mcp-auth exec -- codex exec" }, { env: { PATH: "/bin" }, platform: "darwin", isExecutable: (p) => {
			seen.push(p);
			return false;
		}, exists: () => false, home: "/h", keychainItemStatus: () => null });
		expect(seen.some((p) => p.endsWith("/codex"))).toBe(true);
		expect(seen.some((p) => p.endsWith("/pas"))).toBe(false);
	});
});
