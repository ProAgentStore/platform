/**
 * #1285 — the MCP server row: the full endpoint is visible and copyable, a grant is never shown as if it were a connection, each state
 * has its own words, and the row wraps on a phone. Rendered for real (server-side markup, a router around it), not asserted on source text.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { McpConnectionDisplay } from "../lib/mcpConnections";
import McpConnectionHeader from "./McpConnectionHeader";
import McpConnections from "./McpConnections";

const EP = "https://mcp.proappstore.online/mcp/apps/hiring";
const LONG = "https://a-very-long-hostname.example.com/mcp/apps/hiring/with/a/path/that/is/much/longer/than/sixteen/rem";

function header(over: Partial<Parameters<typeof McpConnectionHeader>[0]> = {}) {
	return renderToStaticMarkup(
		<MemoryRouter>
			<McpConnectionHeader instanceId="inst-1" endpoint={EP} wildcard grantCount={1} state="no_token" accountName={null} focused={false} primary={{ label: "Connect account", onClick: () => undefined }} idPrefix="mcp-test" {...over} />
		</MemoryRouter>,
	);
}

describe("the reported case: a * grant with no token and no connected account", () => {
	const html = header();

	it("does not present the grant as the connection: Permission and Connection are separate, and the state says calls refuse", () => {
		const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
		expect(text).toMatch(/Permission read &amp; write, all tools/);
		expect(text).toMatch(/Connection .{0,3}No token — grant only/);
		expect(html).toContain("No token — grant only");
		expect(html).toMatch(/every call refuses/);
		expect(html).not.toContain("Connected<");
	});

	it("offers the explicit next step, named for the server it acts on", () => {
		expect(html).toContain("Connect account");
		expect(html).toContain(`aria-label="Connect account — ${EP}"`);
	});
});

describe("the endpoint is fully visible and copyable", () => {
	it("renders the whole URL in a focusable, selectable, wrapping block — never truncated", () => {
		const html = header({ endpoint: LONG });
		expect(html).toContain(LONG);
		// The rest of the opening tag that starts at the URL block's id: its role, label, focusability and classes.
		const block = /id="mcp-test-url"[^>]*>/.exec(html)?.[0] ?? "";
		expect(block).toMatch(/break-all/);
		expect(block).toMatch(/select-all/);
		expect(block).toMatch(/w-full/);
				expect(block).toMatch(/readonly/i);
		expect(block).toContain("field-sizing-content");
		expect(block).toContain('aria-labelledby="mcp-test-label"');
		expect(html).not.toMatch(/truncate|max-w-\[16rem\]|overflow-hidden|whitespace-nowrap/);
	});

	it("has an accessible Copy control tied to the URL it copies", () => {
		const html = header();
		expect(html).toContain('aria-label="Copy endpoint URL"');
		expect(html).toContain('aria-describedby="mcp-test-url"');
		expect(html).toContain('id="mcp-test-url"');
		expect(html).toMatch(/role="status"[^>]*aria-live="polite"/);
	});

	it("opens the server in a new tab safely, and tells a screen reader it does", () => {
		const html = header();
		expect(html).toContain(`href="${EP}"`);
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).toContain("(opens in a new tab)");
	});

	it("never links an endpoint that is not exactly a normalized https URL", () => {
		for (const bad of ["javascript:alert(1)", "http://x.example/mcp", "https://x.example/mcp?token=S"]) {
			const html = header({ endpoint: bad });
			expect(html, bad).not.toMatch(/target="_blank"/);
			expect(html, bad).not.toMatch(/href="(javascript|http:)/);
		}
	});

	it("links to this exact server's panel with a deep link that carries only the URL", () => {
		const html = header();
		expect(html).toContain(`href="/instances/inst-1/permissions?focus=permissions&amp;mcp_endpoint=${encodeURIComponent(EP)}"`);
		expect(html).not.toMatch(/token|secret|password/i);
	});
});

describe("each state says what is true", () => {
	const cases: Array<[McpConnectionDisplay, string, RegExp]> = [
		["no_token", "No token — grant only", /every call refuses/],
		["grant_only", "Not connected", /no connected account resolves/],
		["account_required", "Account required", /not set to use one/],
		["connection_failed", "Connection failed", /not working/],
		["connected", "Connected", /will use it/],
		["checking", "Checking…", /Looking up/],
		["unknown", "State unavailable", /could not be read/],
	];
	for (const [state, label, consequence] of cases) {
		it(`${state}: "${label}"`, () => {
			const html = header({ state, primary: null });
			expect(html).toContain(label);
			expect(html).toMatch(consequence);
			expect(html).toContain(`data-state="${state}"`);
			// The symbol is decoration; the words carry the meaning.
			expect(html).toMatch(/aria-hidden="true"/);
		});
	}

	it("shows the selected account only when connected", () => {
		expect(header({ state: "connected", accountName: "Hiring team", primary: null })).toContain("using Hiring team");
		expect(header({ state: "no_token", accountName: "Hiring team" })).not.toContain("Hiring team");
	});

	it("highlights the row a deep link named", () => {
		expect(header({ focused: true })).toMatch(/border-accent/);
		expect(header({ focused: false })).not.toMatch(/border-accent/);
	});
});

describe("on a phone", () => {
	it("the controls wrap instead of overflowing, and nothing has a fixed width", () => {
		const html = header({ endpoint: LONG });
		expect(html).toMatch(/flex flex-wrap items-center/);
		expect(html).not.toMatch(/(^|\s)w-\[\d|min-w-\[|max-w-\[/);
	});

	it("the whole panel, rendered with a grant and nothing connected, shows the full URL, the state and no truncation", () => {
		const html = renderToStaticMarkup(
			<MemoryRouter initialEntries={[`/instances/inst-1/permissions?focus=permissions&mcp_endpoint=${encodeURIComponent(LONG)}`]}>
				<McpConnections instanceId="inst-1" grants={[{ endpoint: LONG, tool: "*" }]} onGrantsChanged={() => undefined} />
			</MemoryRouter>,
		);
		expect(html).toContain('data-testid="mcp-connection"');
		expect(html).toContain(LONG);
		expect(html).toMatch(/Checking…/); // before the lookups answer the panel does not guess "No token"
		expect(html).toMatch(/border-accent/); // the deep-linked row
		expect(html).not.toMatch(/truncate max-w-\[16rem\]/);
		expect(html).not.toContain("read &amp; write</span>");
	});
});
