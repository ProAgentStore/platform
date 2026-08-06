import { describe, expect, it } from "vitest";
import { blockerHint, connectionsFromGrants, credentialNote, hasMcpCapability, normalizeEndpoint, statusBadge, type McpCredential, type McpStatus } from "./mcpConnections";

describe("connectionsFromGrants", () => {
	it("groups grants into one entry per server", () => {
		// The panel's unit is a SERVER, not a grant. Listing 12 rows for one endpoint is the
		// shape the old flat list had, and it made "which servers can this agent reach?"
		// unanswerable at a glance.
		const conns = connectionsFromGrants([
			{ endpoint: "https://b.example/mcp", tool: "x" },
			{ endpoint: "https://a.example/mcp", tool: "y" },
			{ endpoint: "https://a.example/mcp", tool: "*" },
		]);
		expect(conns.map((c) => c.endpoint)).toEqual(["https://a.example/mcp", "https://b.example/mcp"]);
		expect(conns[0].grants).toHaveLength(2);
		expect(conns[0].wildcard).toBe(true);
		expect(conns[1].wildcard).toBe(false);
	});

	it("returns nothing for no grants rather than an empty placeholder row", () => {
		expect(connectionsFromGrants([])).toEqual([]);
	});
});

describe("normalizeEndpoint", () => {
	it("matches the server's normalization so a test result lands on the right connection", () => {
		// If the client and server disagreed about identity, a fresh test would render as a
		// second connection to the same server and the grants would look like they vanished.
		expect(normalizeEndpoint("https://EXAMPLE.com/mcp/")).toBe("https://example.com/mcp");
		expect(normalizeEndpoint("https://example.com/mcp?key=abc#f")).toBe("https://example.com/mcp");
	});

	it("refuses non-https locally, so the Test button doesn't spend a request to be told so", () => {
		expect(normalizeEndpoint("http://example.com/mcp")).toBeNull();
		expect(normalizeEndpoint("not a url")).toBeNull();
	});
});

describe("statusBadge", () => {
	it("colours a credential problem amber, not red", () => {
		// Red reads as "the server is down" and sends the user to check a host that is fine.
		// Both of these mean the server answered and the remedy is one field away.
		expect(statusBadge("credential_missing").tone).toBe("amber");
		expect(statusBadge("auth_required").tone).toBe("amber");
		expect(statusBadge("unreachable").tone).toBe("red");
	});

	it("gives every status its own label — none falls through to a generic failure", () => {
		const all: McpStatus[] = ["connected", "credential_missing", "credential_expired", "auth_required", "unsupported_protocol", "unreachable", "blocked", "permission_denied", "invalid_url"];
		const labels = all.map((s) => statusBadge(s).label);
		expect(new Set(labels).size).toBe(all.length);
	});
});

describe("blockerHint", () => {
	it("gives each blocker a remedy naming where to click", () => {
		expect(blockerHint("no_write_consent")).toMatch(/write access/i);
		expect(blockerHint("tool_disabled")).toMatch(/mcp_call_tool/);
		expect(blockerHint("wildcard_excludes_destructive")).toMatch(/by name/i);
		expect(blockerHint("no_grant")).toMatch(/tick|grant/i);
	});
});

describe("hasMcpCapability", () => {
	it("shows the panel for a discover-only agent, not just a write-capable one", () => {
		// Gating on write access hid the panel until the user had already granted the connector —
		// so the first thing they saw was a kill switch for a capability they could not yet see.
		expect(hasMcpCapability([{ connector: "mcp", allowed: true, disabled: false }])).toBe(true);
		expect(hasMcpCapability([{ connector: "mcp", allowed: false, disabled: true }])).toBe(true);
	});

	it("hides it for an agent that declares no MCP tool at all", () => {
		expect(hasMcpCapability([{ connector: "github", allowed: true, disabled: false }])).toBe(false);
		expect(hasMcpCapability([{ connector: "mcp", allowed: false, disabled: false }])).toBe(false);
	});
});

describe("credentialNote (#286)", () => {
	const cred = (endpoint: string, over: Partial<McpCredential> = {}): McpCredential => ({
		endpoint,
		authMode: "bearer",
		issuer: null,
		scopes: null,
		expiresAt: null,
		expired: false,
		accountLabel: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...over,
	});

	it("reports a credential per server, so one connected server never implies another", () => {
		// The panel used to show one account-wide "MCP token" state, which is the UI half of the
		// bug: it said "connected" for a server that had never been given a credential.
		const creds = [cred("https://a.example.com/mcp")];
		expect(credentialNote(creds, "https://a.example.com/mcp").label).toBe("Token stored");
		expect(credentialNote(creds, "https://b.example.com/mcp")).toEqual({ label: "No token", tone: "amber" });
	});

	it("flags an expired credential rather than showing it as stored", () => {
		const creds = [cred("https://a.example.com/mcp", { expired: true, expiresAt: "2020-01-01T00:00:00Z" })];
		expect(credentialNote(creds, "https://a.example.com/mcp")).toEqual({ label: "Token expired", tone: "amber" });
	});

	it("matches on the exact normalized endpoint, never a prefix", () => {
		// A prefix match would show "token stored" for https://a.example.com/mcp-admin because
		// https://a.example.com/mcp has one — a different server entirely.
		const creds = [cred("https://a.example.com/mcp")];
		expect(credentialNote(creds, "https://a.example.com/mcp-admin").label).toBe("No token");
	});
});
