/** #1006: the console's engine hints see through `pas mcp-auth exec --`, exactly as the API does. */
import { describe, expect, it } from "vitest";
import { engineBin, engineInvocationMode, isClaudeEngine } from "./engine-posture.js";

describe("engine-posture and the pas mcp-auth exec -- wrapper", () => {
	it("resolves the engine after the wrapper", () => {
		expect(engineBin("pas mcp-auth exec -- codex exec")).toBe("codex");
		expect(engineBin("pas mcp-auth exec -- npx codex")).toBe("codex");
		expect(isClaudeEngine("pas mcp-auth exec -- claude -p")).toBe(true);
		expect(engineInvocationMode("pas mcp-auth exec -- codex exec")).toBe(engineInvocationMode("codex exec"));
	});

	it("does not swallow other pas commands, and plain commands are unchanged", () => {
		expect(engineBin("pas something else")).toBe("pas");
		expect(engineBin("codex exec")).toBe("codex");
	});
});
