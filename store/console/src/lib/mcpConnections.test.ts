import { describe, expect, it } from "vitest";
import {
	blockerHint,
	canAuthorize,
	connectionsFromGrants,
	credentialNote,
	hasMcpCapability,
	normalizeEndpoint,
	presetFor,
	statusBadge,
	summarizeSmoke,
	type McpCredential,
	type McpStatus,
} from "./mcpConnections";

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

describe("canAuthorize — only offer Connect where the flow can succeed", () => {
	const auth = (over: Record<string, unknown> = {}) => ({ auth: { protectedResource: true, dynamicRegistration: true, pkceS256: true, ...over } }) as never;

	it("offers the flow for a DCR + PKCE-S256 server", () => {
		expect(canAuthorize(auth())).toBe(true);
	});

	it("stays hidden for a server that publishes no OAuth metadata", () => {
		// That server wants a token. A Connect button here would start a flow the API refuses,
		// which reads as a broken feature rather than as "this one takes a token".
		expect(canAuthorize({ auth: { protectedResource: false } } as never)).toBe(false);
		expect(canAuthorize(null)).toBe(false);
	});

	it("stays hidden without dynamic registration or S256", () => {
		// Both are hard requirements of /v1/mcp/oauth/start: nobody can pre-register a client for a
		// URL the operator has never seen, and a `plain` PKCE challenge equals its verifier.
		expect(canAuthorize(auth({ dynamicRegistration: false }))).toBe(false);
		expect(canAuthorize(auth({ pkceS256: false }))).toBe(false);
		// An older API response that says nothing about PKCE is not an invitation to try anyway.
		expect(canAuthorize(auth({ pkceS256: undefined }))).toBe(false);
	});
});

describe("summarizeSmoke — what the live check reports", () => {
	const envelope = (data: unknown, ok = true) => JSON.stringify({ tool: "list_agents", ok, data });

	it("counts a list and samples its names", () => {
		const s = summarizeSmoke(envelope([{ name: "Coder" }, { slug: "repo-chat" }, { id: "x" }, { name: "Fourth" }]));
		expect(s).toMatchObject({ ok: true, count: 4, sample: ["Coder", "repo-chat", "x"] });
	});

	it("treats a tool that reported failure as a failure", () => {
		// `ok:false` is the remote tool failing while the RPC succeeded. Reading that as success is
		// exactly the "green badge, nothing works" lie the connection panel exists to prevent.
		expect(summarizeSmoke(envelope([], false)).ok).toBe(false);
	});

	it("shows a refusal message verbatim rather than pretending there was a payload", () => {
		// A consent denial comes back as prose, not JSON. The user needs to read it.
		const s = summarizeSmoke('Not permitted: this agent has no consent to call "list_agents"');
		expect(s.count).toBeNull();
		expect(s.detail).toContain("no consent");
	});

	it("finds the list inside a wrapper object", () => {
		expect(summarizeSmoke(envelope({ agents: [{ name: "One" }] })).count).toBe(1);
	});
});

describe("presetFor", () => {
	it("matches a preset only on the exact normalized endpoint", () => {
		// Prefix matching would attach the first-party smoke test — and its scope — to a different
		// server that merely shares a path prefix.
		const presets = [{ id: "p", label: "P", url: "https://mcp.example/mcp", scope: "read", smokeTool: "list_agents", description: "" }];
		expect(presetFor(presets, "https://mcp.example/mcp")?.id).toBe("p");
		expect(presetFor(presets, "https://mcp.example/mcp-admin")).toBeUndefined();
	});
});
