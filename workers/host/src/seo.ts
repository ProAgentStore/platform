/** Public listing metadata comes only from the anonymous catalogue — never the visitor's session. */
import { publicAgentSummary } from "./catalogue-html.js";
type PublicApi = { fetch(input: Request | string): Promise<Response> };
const ORIGIN = "https://proagentstore.online";

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** Replace head metadata, leaving the dashboard code and its owner-only hydration intact. */
export function listingMetadata(html: string, title: string, description: string, canonical: string): string {
	const end = html.indexOf("</head>");
	if (end < 0) return html;
	const head = html.slice(0, end)
		.replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, "")
		.replace(/<meta\b[^>]*>/gi, (tag) => /(?:name|property)=["'](?:description|og:title|og:description|og:url|twitter:title|twitter:description)["']/i.test(tag) ? "" : tag)
		.replace(/<link\b[^>]*>/gi, (tag) => /rel=["']canonical["']/i.test(tag) ? "" : tag);
	const safeTitle = escapeHtml(title);
	const safeDescription = escapeHtml(description);
	const safeUrl = escapeHtml(canonical);
	return `${head}<title>${safeTitle}</title>
  <meta name="description" content="${safeDescription}">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDescription}">
  <meta property="og:url" content="${safeUrl}">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDescription}">
  <link rel="canonical" href="${safeUrl}">
${html.slice(end)}`;
}

export async function publicListingResponse(
	api: PublicApi,
	kind: "agents" | "developers",
	id: string,
	template: string,
	headers: Record<string, string>,
): Promise<Response> {
	const response = await api.fetch(`https://api.proagentstore.online/v1/public/${kind}/${encodeURIComponent(id)}`);
	if (response.status === 404) {
		// A private owner's link can still hydrate from their authenticated client API. Anonymous
		// crawlers get neither a published listing nor a cached generic 200 for a nonexistent slug.
		return new Response(template, { status: 404, headers: { ...headers, "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" } });
	}
	if (!response.ok) throw new Error(`Public ${kind} metadata returned HTTP ${response.status}`);
	const data = await response.json() as { slug?: string; name?: string; description?: string; developer?: { login?: string; name?: string; bio?: string } };
	const profile = kind === "developers" ? data.developer : undefined;
	const name = profile ? profile.name || profile.login : data.name;
	const slug = profile ? profile.login : data.slug;
	if (!name || !slug) throw new Error(`Public ${kind} metadata is incomplete`);
	const title = profile ? `${name} — ProAgentStore Developer` : `${name} — ProAgentStore`;
	const description = (profile ? profile.bio : data.description) || (profile ? `Published ProAgentStore agents by ${name}.` : `${name}, a server-powered AI agent on ProAgentStore.`);
	const html = listingMetadata(template, title, description, `${ORIGIN}/${kind}/${encodeURIComponent(slug)}/`);
	return new Response(profile ? html : publicAgentSummary(html, { slug, name, description }), { headers });
}

/** Page through the same published-only list used by the storefront, including beyond page one. */
export async function publishedSitemapEntries(api: PublicApi): Promise<string> {
	const agents = new Set<string>();
	const developers = new Set<string>();
	for (let offset = 0; ; offset += 100) {
		const response = await api.fetch(`https://api.proagentstore.online/v1/agents?limit=100&offset=${offset}`);
		if (!response.ok) throw new Error(`Public catalogue returned HTTP ${response.status}`);
		const data = await response.json() as { agents?: Array<{ slug: string; creator_login?: string }>; has_more?: boolean };
		if (!Array.isArray(data.agents)) throw new Error("Public catalogue agents are missing");
		for (const agent of data.agents) {
			if (/^[a-z0-9-]+$/.test(agent.slug)) agents.add(agent.slug);
			if (agent.creator_login && /^[a-zA-Z0-9_-]+$/.test(agent.creator_login)) developers.add(agent.creator_login);
		}
		if (!data.has_more) break;
		if (data.agents.length === 0) throw new Error("Public catalogue pagination did not advance");
	}
	return [...[...agents].map((slug) => ["agents", slug]), ...[...developers].map((login) => ["developers", login])]
		.map(([kind, id]) => `  <url><loc>${ORIGIN}/${kind}/${id}/</loc><changefreq>${kind === "agents" ? "daily" : "weekly"}</changefreq></url>\n`).join("");
}
