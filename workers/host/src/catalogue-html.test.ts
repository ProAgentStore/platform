import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { publicCatalogueResponse } from "./catalogue-html.js";
import { publicListingResponse } from "./seo.js";

const homepage = readFileSync(new URL("../../../store/index.html", import.meta.url), "utf8");
const detail = readFileSync(new URL("../../../store/agents/detail.html", import.meta.url), "utf8");
const headers = { "Content-Type": "text/html", "Cache-Control": "public, max-age=300" };
// Inspect the actual response without executing its client bootstrap.
const body = (html: string) => html.replace(/<head\b[^>]*>[\s\S]*?<\/head>|<script\b[^>]*>[\s\S]*?<\/script>/gi, "");

describe("anonymous initial catalogue HTML", () => {
	it("renders published cards and links beyond page one using only escaped public summary fields", async () => {
		const requests: Array<Request | string> = [];
		const api = { async fetch(input: Request | string) {
			requests.push(input);
			return Response.json({ agents: requests.length === 1
				? [{ slug: "one", name: 'One <script> & "Co"', description: 'Useful <img onerror="x"> agent.', system_prompt: "PRIVATE-PROMPT", knowledge: "PRIVATE-KNOWLEDGE" }]
				: [{ slug: "two", name: "Second agent", description: "A different public summary." }, { slug: '../bad', name: 'Invalid URL' }], has_more: requests.length === 1 });
		} };
		const response = await publicCatalogueResponse(api, homepage, headers);
		const html = await response.text();
		expect(requests).toEqual(["https://api.proagentstore.online/v1/agents?limit=100&offset=0", "https://api.proagentstore.online/v1/agents?limit=100&offset=100"]);
		expect(response.status).toBe(200);
		expect(body(html)).toContain('href="/agents/one/"');
		expect(body(html)).toContain('href="/agents/two/"');
		expect(body(html)).toContain('One &lt;script&gt; &amp; &quot;Co&quot;');
		expect(body(html)).toContain('Useful &lt;img onerror=&quot;x&quot;&gt; agent.');
		expect(body(html)).toContain('2 agents');
		for (const secret of ['PRIVATE-PROMPT', 'PRIVATE-KNOWLEDGE', '../bad']) expect(html).not.toContain(secret);
		expect(html).toContain('function renderAgents()');
	});

	it("shows a true empty store and refuses transient/incomplete catalogue responses", async () => {
		const response = await publicCatalogueResponse({ fetch: async () => Response.json({ agents: [] }) }, homepage, headers);
		expect(await response.text()).toContain('id="empty-state" class="empty-state">');
		await expect(publicCatalogueResponse({ fetch: async () => new Response('', { status: 503 }) }, homepage, headers)).rejects.toThrow('HTTP 503');
		await expect(publicCatalogueResponse({ fetch: async () => Response.json({ agents: [], has_more: true }) }, homepage, headers)).rejects.toThrow('pagination');
	});

	it("renders a visible public detail overview while retaining the owner dashboard bootstrap", async () => {
		const api = { fetch: async () => Response.json({ slug: "one", name: 'Agent <One>', description: 'Public & useful.', system_prompt: 'PRIVATE-PROMPT', instances: ['PRIVATE-INSTANCE'] }) };
		const response = await publicListingResponse(api, "agents", "one", detail, headers);
		const html = await response.text();
		expect(body(html)).toContain('<section id="public-agent-summary" class="hero" aria-label="Agent overview">');
		expect(body(html)).toContain('<h1>Agent &lt;One&gt;</h1>');
		expect(body(html)).toContain('<p class="desc">Public &amp; useful.</p>');
		expect(html).toContain('id="loading" class="loading" style="display:none"');
		expect(html).toContain('id="content" style="display:none"');
		expect(html).toContain('async function loadAgent()');
		expect(html).not.toContain('PRIVATE-PROMPT');
		expect(html).not.toContain('PRIVATE-INSTANCE');
	});

	it("never renders a public summary for unknown, private or draft lookups", async () => {
		for (const id of ['unknown', 'private', 'draft']) {
			const response = await publicListingResponse({ fetch: async () => new Response('', { status: 404 }) }, 'agents', id, detail, headers);
			expect(response.status).toBe(404);
			expect(response.headers.get('Cache-Control')).toBe('no-store');
			expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
			expect(body(await response.text())).not.toContain('id="public-agent-summary"');
		}
	});
});
