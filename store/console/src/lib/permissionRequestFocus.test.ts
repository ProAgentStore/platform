import { describe, expect, it } from "vitest";
import { mcpConnectionPath, mcpEndpointFocus, PERMISSIONS_CONTROL_ID, permissionRequestFocus } from "./permissionRequestFocus";

describe("permission request console focus (#1009)", () => {
	it("targets the Permissions & Connections control only for an exact verified link", () => {
		expect(permissionRequestFocus("?focus=permissions&permission_request=pr_1")).toEqual({ controlId: PERMISSIONS_CONTROL_ID, requestId: "pr_1" });
	});

	it("does not focus or fetch for a missing, blank, or unrelated query", () => {
		for (const query of ["", "?focus=permissions", "?focus=other&permission_request=pr_1", "?focus=permissions&permission_request=   "]) expect(permissionRequestFocus(query)).toBeNull();
	});
});

describe("MCP server deep link (#1285)", () => {
	const EP = "https://mcp.proappstore.online/mcp/apps/hiring";

	it("round-trips an endpoint through the path the panel builds", () => {
		const path = mcpConnectionPath("inst/1", EP);
		expect(path).toBe(`/instances/inst%2F1/permissions?focus=permissions&mcp_endpoint=${encodeURIComponent(EP)}`);
		expect(mcpEndpointFocus(path.slice(path.indexOf("?")))).toBe(EP);
	});

	it("accepts only an https URL with no query, fragment or credentials; anything else is ignored, not echoed", () => {
		for (const bad of ["javascript:alert(1)", "http://x.example/mcp", "https://x.example/mcp?token=S", "https://x.example/mcp#frag", "https://user:pw@x.example/mcp", "nope", ""]) {
			expect(mcpEndpointFocus(`?focus=permissions&mcp_endpoint=${encodeURIComponent(bad)}`), bad).toBeNull();
		}
		expect(mcpEndpointFocus(`?mcp_endpoint=${encodeURIComponent(EP)}`)).toBeNull();
		expect(mcpEndpointFocus("?focus=permissions")).toBeNull();
	});

	it("normalizes case and a trailing slash the way the panel keys connections", () => {
		expect(mcpEndpointFocus(`?focus=permissions&mcp_endpoint=${encodeURIComponent("https://MCP.ProAppStore.online/mcp/apps/hiring/")}`)).toBe(EP);
	});
});
