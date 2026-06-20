import { describe, expect, it } from "vitest";
import { buildMcpRemoteArgs, DEFAULT_MCP_URL } from "./mcp.js";

describe("mcp command helpers", () => {
	it("builds default mcp-remote args", () => {
		expect(buildMcpRemoteArgs({})).toEqual([
			"-y",
			"mcp-remote",
			DEFAULT_MCP_URL,
		]);
	});

	it("allows endpoint override and passthrough args", () => {
		expect(buildMcpRemoteArgs(
			{ url: "https://example.com/mcp" },
			["--debug"],
		)).toEqual(["-y", "mcp-remote", "https://example.com/mcp", "--debug"]);
	});
});
