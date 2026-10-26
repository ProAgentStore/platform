/** Visible anonymous content uses only the same published API as the browser. */
type PublicApi = { fetch(input: Request | string): Promise<Response> };
type Summary = { slug: string; name: string; description: string };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char =>
	({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);

export function publicAgentSummary(template: string, summary: Summary): string {
	const content = `<section id="public-agent-summary" class="hero" aria-label="Agent overview"><div>
<h1>${escapeHtml(summary.name)}</h1><p class="desc">${escapeHtml(summary.description)}</p>
<p><a href="/">Browse all agents</a> · <a href="/get-started/">Get started</a></p>
</div></section>`;
	return template.replace('<!-- public-agent-summary -->', () => content)
		.replace('id="loading" class="loading"', 'id="loading" class="loading" style="display:none"');
}

export async function publicCatalogueResponse(api: PublicApi, template: string, headers: Record<string, string>): Promise<Response> {
	const agents = new Map<string, Summary>();
	for (let offset = 0; ; offset += 100) {
		const response = await api.fetch(`https://api.proagentstore.online/v1/agents?limit=100&offset=${offset}`);
		if (!response.ok) throw new Error(`Public catalogue returned HTTP ${response.status}`);
		const data = await response.json() as { agents?: Array<Partial<Summary>>; has_more?: boolean };
		if (!Array.isArray(data.agents)) throw new Error("Public catalogue agents are missing");
		for (const agent of data.agents) {
			if (typeof agent.slug !== "string" || !/^[a-z0-9-]+$/.test(agent.slug) || typeof agent.name !== "string" || !agent.name.trim()) continue;
			agents.set(agent.slug, { slug: agent.slug, name: agent.name, description: typeof agent.description === "string" ? agent.description : "" });
		}
		if (!data.has_more) break;
		if (!data.agents.length || offset >= 9900) throw new Error("Public catalogue pagination did not complete");
	}
	const cards = [...agents.values()].map(agent => `<a class="agent-card" href="/agents/${agent.slug}/">
<div class="agent-icon" aria-hidden="true">&#9889;</div>
<div class="agent-body"><h2 class="agent-name">${escapeHtml(agent.name)}</h2>
<p class="agent-desc">${escapeHtml(agent.description)}</p></div><span class="agent-cta">Get Agent</span></a>`).join("\n");
	let html = template.replace('<div id="agents-grid" class="agents-grid"></div>', () => `<div id="agents-grid" class="agents-grid">${cards}</div>`)
		.replace('<span id="agent-count" class="agent-count"></span>', `<span id="agent-count" class="agent-count">${agents.size} agent${agents.size === 1 ? "" : "s"}</span>`);
	if (!agents.size) html = html.replace('id="empty-state" class="empty-state" style="display:none"', 'id="empty-state" class="empty-state"');
	return new Response(html, { headers });
}
