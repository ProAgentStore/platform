import { describe, expect, it } from "vitest";
// Deployment verification runs as native Node ESM in GitHub Actions.
// @ts-expect-error The deployment script intentionally has no TypeScript build.
import { assertIdentity, expectedIdentity } from "../../../scripts/smoke-mcp-deployment.mjs";

describe("MCP deployment identity smoke check", () => {
	const expected = expectedIdentity('export const MCP_SERVER_VERSION = "1.2.3";', 'export const MCP_TOOL_COUNT = 243;', '"1.2.3": "sha256:catalog"', "commit");
	const healthy = { ...expected, ok: true, deployed_at: "2026-10-03T00:00:00Z" };
	it("extracts the exact version, count, locked schema and build", () => {
		expect(expected).toEqual({ server_name: "ProAgentStore", server_version: "1.2.3", tool_count: 243, schema_revision: "sha256:catalog", build_commit: "commit" });
		expect(() => assertIdentity(healthy, expected)).not.toThrow();
	});
	it.each(["server_version", "tool_count", "schema_revision", "build_commit"])("rejects stale %s even on HTTP 200", (key) => {
		expect(() => assertIdentity({ ...healthy, [key]: "stale" }, expected)).toThrow(key);
	});
	it("requires a deployment timestamp", () => {
		expect(() => assertIdentity({ ...healthy, deployed_at: "unknown" }, expected)).toThrow("timestamp");
	});
});
