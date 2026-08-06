import { describe, expect, it } from "vitest";
import { connectionStatusFor, explainBlocker, parseToolCatalog, summarizeConnection, summarizeTools, type McpConnectionReport } from "./mcp-connection.js";
import { ALL_TOOLS } from "./mcp-consent.js";

describe("connectionStatusFor", () => {
	it("separates 'no token stored' from 'the server rejected the token'", () => {
		// Both used to surface as one "connection failed", which sends the user to re-paste a
		// token that was never the problem — or to hunt a server outage when the vault is empty.
		expect(connectionStatusFor("no_credential", false)).toBe("credential_missing");
		expect(connectionStatusFor("auth", false)).toBe("auth_required");
	});

	it("maps every protocol-negotiation failure onto unsupported_protocol", () => {
		// These three mean "we and this server cannot agree on a wire format" — a client/server
		// version problem with no credential and no network remedy. Reporting them as
		// "unreachable" is what produced the "connected but the tools are broken" bug #260 fixed.
		expect(connectionStatusFor("unsupported_version", false)).toBe("unsupported_protocol");
		expect(connectionStatusFor("header_mismatch", false)).toBe("unsupported_protocol");
		expect(connectionStatusFor("missing_capability", false)).toBe("unsupported_protocol");
	});

	it("keeps an SSRF refusal distinct from a network failure", () => {
		// safeFetch refusing an internal target is OUR decision, not the server being down.
		// Collapsing it into "unreachable" would tell the user to check a host that we will
		// never call however healthy it gets.
		expect(connectionStatusFor("blocked", false)).toBe("blocked");
		expect(connectionStatusFor("network", false)).toBe("unreachable");
	});

	it("reports success as connected regardless of any failure class carried alongside", () => {
		expect(connectionStatusFor(undefined, true)).toBe("connected");
	});
});

describe("parseToolCatalog", () => {
	it("reads the spec shape and the bare-array shape a server might answer with", () => {
		// A server that answers `[…]` instead of `{tools:[…]}` is out of spec but perfectly
		// operable; treating it as "no tools" would make its whole catalog unapprovable.
		expect(parseToolCatalog({ tools: [{ name: "a" }] }).map((t) => t.name)).toEqual(["a"]);
		expect(parseToolCatalog([{ name: "b" }]).map((t) => t.name)).toEqual(["b"]);
		expect(parseToolCatalog({ result: { tools: [{ name: "c" }] } }).map((t) => t.name)).toEqual(["c"]);
	});

	it("drops entries with no usable name", () => {
		// The name becomes a consent row and an `Mcp-Name` header value. A blank or non-string
		// name would create a grant nothing can ever match — a permission record that lies.
		expect(parseToolCatalog({ tools: [{ name: "" }, { name: 7 }, {}, null, { name: " ok " }] }).map((t) => t.name)).toEqual(["ok"]);
	});

	it("bounds a remote catalog's size and its description length", () => {
		// tools/list is attacker-shaped data on its way into a JSON response and a rendered
		// list; an unbounded server reply must not become an unbounded API response.
		const many = { tools: Array.from({ length: 600 }, (_, i) => ({ name: `t${i}`, description: "x".repeat(1000) })) };
		const out = parseToolCatalog(many);
		expect(out).toHaveLength(500);
		expect(out[0].description).toHaveLength(300);
	});

	it("returns empty for anything that isn't a catalog rather than throwing", () => {
		expect(parseToolCatalog(null)).toEqual([]);
		expect(parseToolCatalog("nope")).toEqual([]);
	});
});

describe("summarizeTools", () => {
	const open = { callToolEnabled: true, writeConsent: true };

	it("reports a wildcard-granted tool as callable and a destructive one as not", () => {
		// The wildcard deliberately stops short of destructive-looking names (#262). The panel
		// has to say so, or a user who granted `*` reads the refusal as the grant not working.
		const tools = summarizeTools([{ name: "create_site" }, { name: "delete_site" }], [{ tool: ALL_TOOLS }], open);
		expect(tools[0]).toMatchObject({ granted: true, callable: true });
		expect(tools[1]).toMatchObject({ destructive: true, granted: false, callable: false, blockedBy: "wildcard_excludes_destructive" });
	});

	it("judges destructiveness on the name, never on what the server said about itself", () => {
		// The annotation is authored by the party being defended against: a server could label
		// delete_everything as safe and collect a wildcard grant. The catalog parser does not
		// even carry annotations, so there is nothing here that could start trusting them.
		const tools = summarizeTools([{ name: "purgeAll", description: "readOnlyHint: true, destructiveHint: false" }], [{ tool: ALL_TOOLS }], open);
		expect(tools[0].destructive).toBe(true);
		expect(tools[0].callable).toBe(false);
	});

	it("names the OUTERMOST gate first, so the user fixes the one that is actually stopping them", () => {
		// Suggesting "grant this tool" to someone whose connector write access is off produces a
		// grant that changes nothing — which reads as the product being broken.
		const noConsent = summarizeTools([{ name: "x" }], [{ tool: "x" }], { callToolEnabled: true, writeConsent: false });
		expect(noConsent[0]).toMatchObject({ granted: true, callable: false, blockedBy: "no_write_consent" });

		const toolOff = summarizeTools([{ name: "x" }], [{ tool: "x" }], { callToolEnabled: false, writeConsent: true });
		expect(toolOff[0].blockedBy).toBe("tool_disabled");
	});

	it("treats an exact grant as covering a destructive name", () => {
		// Approving `delete_site` BY NAME is the explicit confirmation the wildcard withholds.
		const tools = summarizeTools([{ name: "delete_site" }], [{ tool: "delete_site" }], open);
		expect(tools[0]).toMatchObject({ destructive: true, granted: true, callable: true });
	});
});

describe("summarizeConnection", () => {
	const base = (over: Partial<McpConnectionReport>): Omit<McpConnectionReport, "detail"> => ({
		endpoint: "https://example.com/mcp",
		status: "connected",
		durationMs: 12,
		tools: [],
		toolCount: 0,
		callableCount: 0,
		gates: { callToolEnabled: true, writeConsent: true },
		...over,
	});

	it("refuses to call a connection successful when the agent may call nothing", () => {
		// THE failure this whole surface exists to prevent: a green "Connected" while every real
		// call would be refused by consent. The headline must carry both numbers.
		const detail = summarizeConnection(base({ toolCount: 14, callableCount: 0 }), "ignored");
		expect(detail).toContain("14 tools found");
		expect(detail).toContain("may call none of them");
	});

	it("states the shortfall when only some tools are callable", () => {
		expect(summarizeConnection(base({ toolCount: 5, callableCount: 2 }), "ignored")).toContain("2 of 5");
	});

	it("passes the transport's own actionable text through on failure", () => {
		// On a failure the connector already produced a precise, redacted sentence (which auth
		// server fronts it, which versions each side speaks). Replacing it with a generic
		// "connection failed" would throw away the only actionable part of the diagnosis.
		const detail = summarizeConnection(base({ status: "auth_required", toolCount: 0 }), "MCP server rejected the credential (HTTP 401).");
		expect(detail).toBe("MCP server rejected the credential (HTTP 401).");
	});

	it("names the negotiated era and version on success", () => {
		const detail = summarizeConnection(base({ toolCount: 1, callableCount: 1, era: "legacy", protocolVersion: "2025-06-18" }), "");
		expect(detail).toContain("2025-06-18");
		expect(detail).toContain("legacy");
	});
});

describe("explainBlocker", () => {
	it("gives every blocker a remedy that names where to click", () => {
		// A refusal with no remedy gets read as "MCP is broken" and the grant never happens.
		for (const b of ["no_grant", "wildcard_excludes_destructive", "no_write_consent", "tool_disabled"] as const) {
			expect(explainBlocker(b, "delete_site").length).toBeGreaterThan(20);
		}
		expect(explainBlocker("wildcard_excludes_destructive", "delete_site")).toContain("delete_site");
	});
});
