import { describe, expect, it } from "vitest";
import { firstPartyMcpPresets } from "./mcp-presets.js";

describe("first-party MCP presets (#287)", () => {
	it("normalizes the configured endpoint to the form everything else keys on", () => {
		// Consent, the credential store and the trace all key on the normalized endpoint. A preset
		// that prefilled `https://MCP.Example.Online/mcp/` would look connected while its grants and
		// credential were filed under a different string.
		expect(firstPartyMcpPresets({ MCP_SELF_URL: "https://MCP.Example.Online/mcp/" })[0]?.url).toBe("https://mcp.example.online/mcp");
	});

	it("offers nothing for an unset or non-https value", () => {
		// Unset is the normal state of a local build, not an error — and an http endpoint is one the
		// connector would refuse anyway, so offering it would only produce a button that always fails.
		expect(firstPartyMcpPresets({})).toEqual([]);
		expect(firstPartyMcpPresets({ MCP_SELF_URL: "" })).toEqual([]);
		expect(firstPartyMcpPresets({ MCP_SELF_URL: "http://mcp.example.online/mcp" })).toEqual([]);
		expect(firstPartyMcpPresets({ MCP_SELF_URL: "not a url" })).toEqual([]);
	});

	it("asks for read scope only", () => {
		// The platform's own MCP server also publishes write/runtime/destructive scopes. A dogfood
		// smoke test that lists agents has no business holding the ability to mutate the account
		// that authorized it.
		expect(firstPartyMcpPresets({ MCP_SELF_URL: "https://mcp.example.online/mcp" })[0]?.scope).toBe("read");
	});
});
