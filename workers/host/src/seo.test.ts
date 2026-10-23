import { describe, expect, it } from "vitest";
import worker from "./index";
import { listingMetadata, publicListingResponse, publishedSitemapEntries } from "./seo";

const template = `<!doctype html><html><head><title>Agent dashboard</title>
<meta name="description" content="Generic description"><meta property="og:title" content="Generic">
<meta property="og:description" content="Generic"><meta property="og:url" content="https://proagentstore.online/agents/">
<link rel="canonical" href="https://proagentstore.online/agents/"><link rel="icon" href="/favicon.svg">
</head><body><div id="root"></div><script>hydrateOwnerDashboard()</script></body></html>`;
const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" };
const json = (value: unknown) => Response.json(value);

describe("public catalogue SEO", () => {
	it("gives each published agent its own safely escaped canonical, title and descriptions", async () => {
		const requests: Array<Request | string> = [];
		const api = { async fetch(input: Request | string) {
			requests.push(input);
			return json({ slug: "local-coder", name: 'Code <Buddy> & "Co"', description: 'Read "files" & fix <bugs>.' });
		} };
		const response = await publicListingResponse(api, "agents", "agent-id", template, headers);
		const html = await response.text();
		expect(response.status).toBe(200);
		expect(requests).toEqual(["https://api.proagentstore.online/v1/public/agents/agent-id"]);
		expect(html).toContain('<link rel="canonical" href="https://proagentstore.online/agents/local-coder/">');
		expect(html).toContain('<meta property="og:url" content="https://proagentstore.online/agents/local-coder/">');
		expect(html).toContain("<title>Code &lt;Buddy&gt; &amp; &quot;Co&quot; — ProAgentStore</title>");
		expect(html).toContain('name="description" content="Read &quot;files&quot; &amp; fix &lt;bugs&gt;."');
		expect(html.match(/rel="canonical"/g)).toHaveLength(1);
		expect(html).not.toContain("Generic description");
		expect(html).toContain("hydrateOwnerDashboard()");
		expect(html).toContain('href="/favicon.svg"');
	});

	it("gives a developer profile its public identity without exposing account fields", async () => {
		const api = { async fetch() { return json({ developer: { login: "alice", name: "Alice", bio: "Builds useful agents." } }); } };
		const response = await publicListingResponse(api, "developers", "alice", template, headers);
		const html = await response.text();
		expect(html).toContain("<title>Alice — ProAgentStore Developer</title>");
		expect(html).toContain('href="https://proagentstore.online/developers/alice/"');
		expect(html).toContain('content="Builds useful agents."');
	});

	it("keeps an unpublished owner shell usable while returning a non-cacheable public 404/noindex", async () => {
		const api = { async fetch() { return new Response("Not found", { status: 404 }); } };
		const response = await publicListingResponse(api, "agents", "private-agent", template, headers);
		expect(response.status).toBe(404);
		expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.text()).toContain("hydrateOwnerDashboard()");
	});

	it("does not turn a catalogue outage into an indexable generic listing or a permanent 404", async () => {
		const api = { async fetch() { return new Response("Unavailable", { status: 503 }); } };
		await expect(publicListingResponse(api, "agents", "local-coder", template, headers)).rejects.toThrow("HTTP 503");
	});

	it("pages through the published catalogue, deduplicates creators and refuses invalid URL fragments", async () => {
		const requests: Array<Request | string> = [];
		const api = { async fetch(input: Request | string) {
			requests.push(input);
			return requests.length === 1
				? json({ agents: [{ slug: "one", creator_login: "alice" }], has_more: true })
				: json({ agents: [{ slug: "two", creator_login: "alice" }, { slug: "<script>", creator_login: "x&y" }], has_more: false });
		} };
		const entries = await publishedSitemapEntries(api);
		expect(requests).toEqual(["https://api.proagentstore.online/v1/agents?limit=100&offset=0", "https://api.proagentstore.online/v1/agents?limit=100&offset=100"]);
		expect(entries).toContain("/agents/one/");
		expect(entries).toContain("/agents/two/");
		expect(entries.match(/\/developers\/alice\//g)).toHaveLength(1);
		expect(entries).not.toContain("<script>");
		expect(entries).not.toContain("x&y");
	});

	it("replaces old head entries rather than duplicating tags", () => {
		const html = listingMetadata(template, "Agent", "Description", "https://proagentstore.online/agents/one/");
		expect(html.match(/<title>/g)).toHaveLength(1);
		expect(html.match(/name="description"/g)).toHaveLength(1);
		expect(html.match(/property="og:url"/g)).toHaveLength(1);
	});
});

describe("host search-discovery boundaries", () => {
	it("excludes account UI from the sitemap and allows Google to read its noindex directive", async () => {
		const env = { API: { async fetch() { return json({ agents: [{ slug: "local-coder" }], has_more: false }); } } };
		const response = await worker.fetch(new Request("https://proagentstore.online/sitemap.xml"), env as never);
		const sitemap = await response.text();
		expect(sitemap).toContain("https://proagentstore.online/agents/local-coder/");
		expect(sitemap).not.toContain("/console");
		expect(sitemap).not.toContain("/admin");
		const robots = await worker.fetch(new Request("https://proagentstore.online/robots.txt"), env as never);
		const text = await robots.text();
		expect(text).not.toContain("Disallow: /console/");
		expect(text).toContain("Disallow: /admin/api/");
	});

	it("marks root and nested console/admin shells noindex without caching account UI", async () => {
		const env = { API: { async fetch() { throw new Error("Account UI does not need the catalogue"); } } };
		for (const url of ["https://proagentstore.online/console", "https://proagentstore.online/console/", "https://proagentstore.online/console/instances/one", "https://proagentstore.online/admin", "https://proagentstore.online/admin/users", "https://console.proagentstore.online/", "https://console.proagentstore.online/fleet"]) {
			const response = await worker.fetch(new Request(url), env as never);
			expect(response.status, url).toBe(200);
			expect(response.headers.get("X-Robots-Tag"), url).toBe("noindex, nofollow");
			expect(response.headers.get("Cache-Control"), url).toBe("no-store");
		}
	});

	it("never forwards the visitor's credentials into a public listing lookup", async () => {
		const requests: Array<Request | string> = [];
		const env = { API: { async fetch(input: Request | string) {
			requests.push(input);
			return new Response("Not found", { status: 404 });
		} } };
		const response = await worker.fetch(new Request("https://proagentstore.online/agents/private-agent/", { headers: { Authorization: "Bearer owner-token", Cookie: "session=owner" } }), env as never);
		expect(response.status).toBe(404);
		expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
		expect(requests).toEqual(["https://api.proagentstore.online/v1/public/agents/private-agent"]);
	});
});
