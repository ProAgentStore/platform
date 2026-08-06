import { describe, expect, it } from "vitest";
import type { Env } from "./types.js";
import { ALL_TOOLS, hasMcpConsent, isDestructiveToolName, mcpConsentDenial, normalizeMcpEndpoint } from "./mcp-consent.js";

/** A D1 stub that answers the consent SELECT from a fixed row set, recording the binds so a
 *  test can prove the query is parameterized and scoped rather than filtered in JS. */
function envWithGrants(rows: Array<{ tool: string }>, opts: { throws?: boolean } = {}) {
	const binds: unknown[][] = [];
	const env = {
		DB: {
			prepare: (_sql: string) => ({
				bind: (...args: unknown[]) => {
					binds.push(args);
					return {
						all: async () => {
							if (opts.throws) throw new Error("d1 down");
							// Mirror D1: only rows matching the bound tool names come back.
							const [, , tool, wildcard] = args as string[];
							return { results: rows.filter((r) => r.tool === tool || r.tool === wildcard) };
						},
					};
				},
			}),
		},
	} as unknown as Env;
	return { env, binds };
}

describe("normalizeMcpEndpoint", () => {
	it("drops the query string, because an MCP endpoint's query is routinely a credential", () => {
		// The raw URL is logged (#265) and used as a consent key; keeping `?key=…` would both
		// leak the secret into agent_events and give every distinct key its own consent bucket.
		expect(normalizeMcpEndpoint("https://example.com/mcp?key=sk-live-abc#frag")).toBe("https://example.com/mcp");
	});

	it("strips userinfo so a credential in the URL can't ride into the consent key", () => {
		expect(normalizeMcpEndpoint("https://user:pass@example.com/mcp")).toBe("https://example.com/mcp");
	});

	it("collapses trailing-slash and host-case variants onto one key", () => {
		// Otherwise consent granted for `/mcp` is silently absent for `/mcp/` and the agent gets
		// a refusal the owner cannot explain.
		expect(normalizeMcpEndpoint("https://EXAMPLE.com/mcp/")).toBe("https://example.com/mcp");
	});

	it("keeps the port, since a different port is a different server", () => {
		expect(normalizeMcpEndpoint("https://example.com:8443/mcp")).toBe("https://example.com:8443/mcp");
	});

	it("returns null for non-https or unparseable input rather than inventing a key", () => {
		// A fallback key would collapse every bad URL into one shared consent bucket — grant one,
		// grant them all.
		expect(normalizeMcpEndpoint("http://example.com/mcp")).toBeNull();
		expect(normalizeMcpEndpoint("not a url")).toBeNull();
		expect(normalizeMcpEndpoint("")).toBeNull();
	});
});

describe("isDestructiveToolName", () => {
	it("matches the destroy-shaped verbs a wildcard grant must not silently cover", () => {
		for (const n of ["delete_site", "purge_cache", "removeUser", "drop_table", "reset_account", "overwrite_page"]) {
			expect(isDestructiveToolName(n)).toBe(true);
		}
	});

	it("does not fire on words that merely contain one", () => {
		// "undeleted"/"predrop" style false positives would make ordinary tools unreachable under
		// a wildcard for no security gain.
		for (const n of ["create_site", "list_templates", "undeleted_items", "resetting"]) {
			expect(isDestructiveToolName(n)).toBe(false);
		}
	});
});

describe("hasMcpConsent", () => {
	it("allows a tool with its own grant", async () => {
		const { env } = envWithGrants([{ tool: "create_site" }]);
		expect(await hasMcpConsent(env, "inst-1", "https://example.com/mcp", "create_site")).toBe(true);
	});

	it("allows an ordinary tool under a wildcard grant", async () => {
		const { env } = envWithGrants([{ tool: ALL_TOOLS }]);
		expect(await hasMcpConsent(env, "inst-1", "https://example.com/mcp", "add_section")).toBe(true);
	});

	it("refuses a destructive-looking tool under a wildcard alone", async () => {
		// "let this agent operate my site builder" must not quietly include delete_site.
		const { env } = envWithGrants([{ tool: ALL_TOOLS }]);
		expect(await hasMcpConsent(env, "inst-1", "https://example.com/mcp", "delete_site")).toBe(false);
	});

	it("allows a destructive tool once it is granted by name", async () => {
		const { env } = envWithGrants([{ tool: ALL_TOOLS }, { tool: "delete_site" }]);
		expect(await hasMcpConsent(env, "inst-1", "https://example.com/mcp", "delete_site")).toBe(true);
	});

	it("is scoped by instance and endpoint in the QUERY, not filtered afterwards", async () => {
		const { env, binds } = envWithGrants([{ tool: ALL_TOOLS }]);
		await hasMcpConsent(env, "inst-1", "https://example.com/mcp", "add_section");
		expect(binds[0]).toEqual(["inst-1", "https://example.com/mcp", "add_section", ALL_TOOLS]);
	});

	it("fails closed with no instance, no endpoint, or a D1 error", async () => {
		const { env } = envWithGrants([{ tool: ALL_TOOLS }]);
		expect(await hasMcpConsent(env, undefined, "https://example.com/mcp", "x")).toBe(false);
		expect(await hasMcpConsent(env, "inst-1", null, "x")).toBe(false);
		expect(await hasMcpConsent(env, "inst-1", "https://example.com/mcp", "")).toBe(false);

		const { env: broken } = envWithGrants([{ tool: ALL_TOOLS }], { throws: true });
		// A database outage must not become an open door.
		expect(await hasMcpConsent(broken, "inst-1", "https://example.com/mcp", "add_section")).toBe(false);
	});
});

describe("mcpConsentDenial", () => {
	it("names the server and the tool so the owner knows what to grant", async () => {
		const msg = mcpConsentDenial("https://example.com/mcp", "create_site");
		expect(msg).toContain("https://example.com/mcp");
		expect(msg).toContain("create_site");
	});

	it("explains the extra hurdle for a destructive tool", () => {
		// Without this the owner sees a refusal despite having granted "all tools" and reads it
		// as a bug.
		expect(mcpConsentDenial("https://example.com/mcp", "delete_site")).toMatch(/destructive/);
	});
});
