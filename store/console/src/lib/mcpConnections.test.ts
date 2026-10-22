import { describe, expect, it } from "vitest";
import {
	blockerHint,
	canAuthorize,
	connectionStateBadge,
	connectionsFromGrants,
	credentialNote,
	deriveMcpConnectionState,
	hasMcpCapability,
	mcpAccountNotice,
	mcpAccountRows,
	mcpNeedsAccountChoice,
	normalizeEndpoint,
	openableEndpoint,
	presetFor,
	selectedAccountName,
	statusBadge,
	summarizeSmoke,
	surfaceLine,
	type McpAccountsState,
	type McpConnectionState,
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
		accountId: "",
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

describe("surfaceLine — the resources/prompts line (#263)", () => {
	const s = (over: Partial<Parameters<typeof surfaceLine>[0]> = {}) => ({ state: "available" as const, count: 3, more: false, listEnabled: true, readEnabled: true, detail: "", ...over });

	it("colours by REACH, not by availability", () => {
		// A server publishing 40 resources this agent cannot list is not good news. Neutral tone
		// there would read as "all fine" for the precise state that silently does nothing.
		expect(surfaceLine(s())).toEqual({ label: "3 · listable and readable", tone: "muted" });
		expect(surfaceLine(s({ listEnabled: false })).tone).toBe("amber");
		expect(surfaceLine(s({ readEnabled: false }))).toEqual({ label: "3 · list only", tone: "amber" });
	});

	it("treats 'the server has none' as neutral, not as a problem", () => {
		// There is nothing to fix, and amber sends people hunting for a setting that wouldn't help.
		expect(surfaceLine(s({ state: "unsupported", count: 0 }))).toEqual({ label: "none published", tone: "muted" });
		expect(surfaceLine(s({ count: 0 })).tone).toBe("muted");
	});

	it("flags a surface we could not read, which is not the same as an empty one", () => {
		expect(surfaceLine(s({ state: "unreadable", count: 0 }))).toEqual({ label: "couldn’t read", tone: "amber" });
	});

	it("shows a paged count as a page", () => {
		expect(surfaceLine(s({ count: 200, more: true })).label).toContain("200+");
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

describe("per-endpoint account pinning (#1267)", () => {
	const state = (over: Partial<McpAccountsState> = {}): McpAccountsState => ({
		endpoint: "https://mcp.example/mcp",
		accounts: [{ accountId: "work", label: "Work", connectedAt: null }],
		pinned: null,
		resolves: "work",
		blocked: null,
		...over,
	});

	it("needs no choice with a single account", () => {
		expect(mcpNeedsAccountChoice(state())).toBe(false);
	});

	it("needs a choice with two or more accounts", () => {
		expect(
			mcpNeedsAccountChoice(state({ accounts: [{ accountId: "work", label: "Work", connectedAt: null }, { accountId: "personal", label: "Personal", connectedAt: null }] })),
		).toBe(true);
	});

	it("names the account a call would use, when one resolves", () => {
		expect(mcpAccountNotice(state())).toEqual({ blocked: false, message: "This instance uses Work." });
	});

	it("falls back to the accountId when the row carries no label", () => {
		expect(mcpAccountNotice(state({ accounts: [{ accountId: "work", label: null, connectedAt: null }] }))).toEqual({ blocked: false, message: "This instance uses work." });
	});

	it("renders the server's own refusal message verbatim when resolves is null", () => {
		const s = state({ resolves: null, blocked: { reason: "ambiguous", message: "You have 2 accounts connected and this agent is not set to use one of them." } });
		expect(mcpAccountNotice(s)).toEqual({ blocked: true, message: "You have 2 accounts connected and this agent is not set to use one of them." });
	});

	it("falls back to a generic sentence if resolves is null with no message", () => {
		expect(mcpAccountNotice(state({ resolves: null, blocked: null })).blocked).toBe(true);
	});

	it("names an unlabelled account by its id, never blank", () => {
		expect(mcpAccountRows(state({ accounts: [{ accountId: "", label: null, connectedAt: null }] }))).toEqual([{ accountId: "", name: "unnamed connection" }]);
	});
});

describe("statusBadge — the two multi-account verdicts (#1267)", () => {
	it("colours account_ambiguous and pinned_account_gone amber, not red", () => {
		// The server is reachable and the remedy is a pin away — colouring it like an outage
		// would send someone to check a host that is fine.
		expect(statusBadge("account_ambiguous" as McpStatus).tone).toBe("amber");
		expect(statusBadge("pinned_account_gone" as McpStatus).tone).toBe("amber");
	});
});


// ── #1285: a grant is not a connection ──────────────────────────────────────────────────────────

describe("deriveMcpConnectionState (#1285)", () => {
	const EP = "https://mcp.proappstore.online/mcp/apps/hiring";
	const GRANTS = [{ endpoint: EP, tool: "*" }];
	const CRED: McpCredential = { endpoint: EP, accountId: "", authMode: "oauth", issuer: null, scopes: null, expiresAt: null, expired: false, accountLabel: null, createdAt: "2026-10-01", updatedAt: "2026-10-01" };
	const accts = (over: Partial<McpAccountsState> = {}): McpAccountsState => ({ endpoint: EP, accounts: [], pinned: null, resolves: null, blocked: null, ...over });
	const derive = (over: { credentials?: McpCredential[]; accounts?: McpAccountsState | null; lastStatus?: McpStatus | null; grants?: typeof GRANTS } = {}): McpConnectionState =>
		deriveMcpConnectionState({ endpoint: EP, grants: over.grants ?? GRANTS, credentials: over.credentials ?? [CRED], accounts: over.accounts === undefined ? null : over.accounts, lastStatus: over.lastStatus ?? null });

	it("the reported case: a * grant, no token, no connected account is NO TOKEN — not a working read & write server", () => {
		const reported = accts({ blocked: { reason: "not_connected", message: "No account is connected on this server." } });
		expect(derive({ credentials: [], accounts: reported })).toBe("no_token");
	});

	it("a grant alone with no credential at all is no_token, whatever the account lookup says", () => {
		expect(derive({ credentials: [] })).toBe("no_token");
		expect(derive({ credentials: [], accounts: accts({ accounts: [{ accountId: "w", label: "Work", connectedAt: null }], resolves: "w" }) })).toBe("no_token");
	});

	it("a credential held but the server reports not_connected is grant_only", () => {
		expect(derive({ accounts: accts({ blocked: { reason: "not_connected", message: "m" } }) })).toBe("grant_only");
	});

	it("a credential, no accounts, nothing blocked and nothing resolving is grant_only — never 'connected'", () => {
		expect(derive({ accounts: accts({ accounts: [], blocked: null, resolves: null }) })).toBe("grant_only");
	});

	it("an account that resolves is connected", () => {
		expect(derive({ accounts: accts({ accounts: [{ accountId: "work", label: "Work", connectedAt: null }], resolves: "work" }) })).toBe("connected");
	});

	it("an account choice still owed is account_required: ambiguous, a pin to an account that is gone, or accounts with none resolving", () => {
		expect(derive({ accounts: accts({ blocked: { reason: "ambiguous", message: "m" } }) })).toBe("account_required");
		expect(derive({ accounts: accts({ blocked: { reason: "pinned_account_gone", message: "m" } }) })).toBe("account_required");
		expect(derive({ accounts: accts({ accounts: [{ accountId: "a", label: null, connectedAt: null }, { accountId: "b", label: null, connectedAt: null }], resolves: null }) })).toBe("account_required");
		expect(derive({ lastStatus: "account_ambiguous" })).toBe("account_required");
	});

	it("a failed test is connection_failed, for every failure status", () => {
		for (const status of ["credential_missing", "credential_expired", "auth_required", "unreachable", "unsupported_protocol", "blocked", "permission_denied", "invalid_url"] as McpStatus[]) {
			expect(derive({ lastStatus: status }), status).toBe("connection_failed");
		}
	});

	it("a stored credential that has expired is connection_failed even before any test", () => {
		expect(derive({ credentials: [{ ...CRED, expired: true }] })).toBe("connection_failed");
	});

	it("a failed test beats a resolving account: the server says it does not work, so the badge does not say it does", () => {
		const resolving = accts({ accounts: [{ accountId: "w", label: "W", connectedAt: null }], resolves: "w" });
		expect(derive({ accounts: resolving, lastStatus: "unreachable" })).toBe("connection_failed");
		expect(derive({ accounts: resolving, lastStatus: "connected" })).toBe("connected");
	});

	it("falls back to grant_only when nothing is known, and for an endpoint with no grants", () => {
		expect(derive({ accounts: null })).toBe("grant_only");
		expect(derive({ grants: [] })).toBe("grant_only");
	});

	it("matches the credential by the endpoint, not by any credential the owner holds", () => {
		expect(derive({ credentials: [{ ...CRED, endpoint: "https://other.example/mcp" }] })).toBe("no_token");
	});
});

describe("connection state presentation (#1285)", () => {
	const STATES = ["no_token", "grant_only", "account_required", "connection_failed", "connected", "checking", "unknown"] as const;

	it("every state has its own words AND symbol, so none is told apart by colour alone", () => {
		const badges = STATES.map((s) => connectionStateBadge(s));
		expect(new Set(badges.map((b) => b.label)).size).toBe(STATES.length);
		expect(new Set(badges.map((b) => b.symbol)).size).toBeGreaterThanOrEqual(5);
		for (const b of badges) expect(b.consequence.length).toBeGreaterThan(20);
	});

	it("the words say what the owner needs to know: only 'connected' is green, and the grant-only states say calls refuse", () => {
		expect(connectionStateBadge("connected").tone).toBe("green");
		expect(connectionStateBadge("connection_failed").tone).toBe("red");
		for (const s of ["no_token", "grant_only", "account_required"] as const) {
			expect(connectionStateBadge(s).tone).toBe("amber");
			expect(connectionStateBadge(s).consequence).toMatch(/every call refuses/);
		}
		expect(connectionStateBadge("no_token").label).toBe("No token — grant only");
		expect(connectionStateBadge("grant_only").label).toBe("Not connected");
	});

	it("names the account a call would use, by its label, or nothing when none resolves", () => {
		const a = { accounts: [{ accountId: "w1", label: "Work", connectedAt: null }], resolves: "w1" };
		expect(selectedAccountName(a)).toBe("Work");
		expect(selectedAccountName({ ...a, resolves: null })).toBeNull();
		expect(selectedAccountName(null)).toBeNull();
	});

	it("opens only a normalized https endpoint: no javascript:, no query with a token, no http", () => {
		expect(openableEndpoint("https://mcp.proappstore.online/mcp/apps/hiring")).toBe("https://mcp.proappstore.online/mcp/apps/hiring");
		for (const bad of ["javascript:alert(1)", "http://example.com/mcp", "https://example.com/mcp?token=SECRET", "https://example.com/mcp/", "not a url", ""]) expect(openableEndpoint(bad), bad).toBeNull();
	});

	it("the account picker is owed when a pin points at a vanished account or none is chosen, even with one account left", () => {
		const one = [{ accountId: "w", label: "W", connectedAt: null }];
		expect(mcpNeedsAccountChoice({ accounts: one })).toBe(false);
		expect(mcpNeedsAccountChoice({ accounts: one, blocked: { reason: "pinned_account_gone", message: "m" } })).toBe(true);
		expect(mcpNeedsAccountChoice({ accounts: one, blocked: { reason: "ambiguous", message: "m" } })).toBe(true);
		expect(mcpNeedsAccountChoice({ accounts: [], blocked: { reason: "not_connected", message: "m" } })).toBe(false);
	});
});
