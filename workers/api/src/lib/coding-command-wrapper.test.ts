/**
 * #1006 / PAS #356 — `pas mcp-auth exec -- <engine …>` is a launcher wrapper.
 *
 * The ProAppStore CLI runs the engine with the owner's remote PAS MCP credential in that process's
 * environment only, so a preset may be `pas mcp-auth exec -- codex exec …`. Everything that reasons
 * about the ENGINE must see what follows `--`: the client type, Codex's structured `exec` mode, the
 * model flag. And the match is exact: `pas` followed by anything else is not swallowed.
 */
import { describe, expect, it } from "vitest";
import { commandEngineParts, deriveClientType } from "./coding-command.js";
import { readEngineModel, writeEngineModel } from "./coding-engine-model.js";
import { expectedEngineInvocationMode } from "./coding-engines.js";

describe("the pas mcp-auth exec -- wrapper", () => {
	it("pas mcp-auth exec -- codex → engine codex", () => {
		expect(commandEngineParts("pas mcp-auth exec -- codex")).toEqual({ bin: "codex", args: [] });
		expect(deriveClientType("pas mcp-auth exec -- codex")).toBe("codex");
	});

	it("pas mcp-auth exec -- codex --model o4-mini \"do thing\" → engine codex, model read from it", () => {
		const cmd = 'pas mcp-auth exec -- codex --model o4-mini "do thing"';
		expect(commandEngineParts(cmd).bin).toBe("codex");
		expect(commandEngineParts(cmd).args.slice(0, 2)).toEqual(["--model", "o4-mini"]);
		expect(readEngineModel(cmd)).toBe("o4-mini");
	});

	it("writing a model lands after the ENGINE (and its exec), never after the wrapper", () => {
		const cmd = "pas mcp-auth exec -- codex exec --sandbox danger-full-access";
		expect(writeEngineModel(cmd, "gpt-5.1-codex")).toBe("pas mcp-auth exec -- codex exec --model gpt-5.1-codex --sandbox danger-full-access");
		expect(readEngineModel(writeEngineModel(cmd, "gpt-5.1-codex"))).toBe("gpt-5.1-codex");
	});

	it("pas mcp-auth exec -- npx codex → engine codex (a launcher inside the wrapper)", () => {
		expect(commandEngineParts("pas mcp-auth exec -- npx codex exec").bin).toBe("codex");
		expect(commandEngineParts("PAS_X=1 /usr/local/bin/pas mcp-auth exec -- env FOO=1 bunx codex exec").bin).toBe("codex");
	});

	it("Codex's structured exec mode survives the wrapper", () => {
		expect(expectedEngineInvocationMode("codex", "pas mcp-auth exec -- codex exec --sandbox danger-full-access")).toBe("structured");
		expect(expectedEngineInvocationMode("codex", "pas mcp-auth exec -- codex resume")).toBe("raw");
	});

	it("a plain codex invocation is unchanged", () => {
		expect(commandEngineParts("codex exec --sandbox danger-full-access")).toEqual({ bin: "codex", args: ["exec", "--sandbox", "danger-full-access"] });
		expect(deriveClientType("codex exec")).toBe("codex");
		expect(expectedEngineInvocationMode("codex", "codex exec")).toBe("structured");
		expect(deriveClientType("npx claude --dangerously-skip-permissions")).toBe("claude");
	});

	it.each(["pas something else", "pas mcp-auth status", "pas mcp-auth exec codex", "pas mcp-auth -- codex"])("%s is NOT a wrapper — the binary stays pas", (cmd) => {
		expect(commandEngineParts(cmd).bin).toBe("pas");
	});
});
