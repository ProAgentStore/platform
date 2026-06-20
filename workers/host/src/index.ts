/**
 * ProAgentStore host worker — serves pages, assets, console, widget.
 * Pages inlined from store/ at build time via build.js → pages.ts.
 */
import {
	homepage, aboutPage, getStartedPage, skillsPage, skillMcpOperatorPage, browserRuntimeDocsPage, mcpDocsPage, consolePage, agentDetailPage,
	widgetJs, authWidgetJs, developerProfilePage, adminPage, notFoundPage, changelogPage, openapiYaml,
	llmsTxt, llmsFullTxt, skillsJson, mcpServerJson,
	faviconSvg, manifestJson,
	icon16, icon32, icon180, icon192, icon512, ogImage,
} from "./pages.js";

const PAGES: Record<string, string> = {
	"/": homepage,
	"/about": aboutPage,
	"/about/": aboutPage,
	"/get-started": getStartedPage,
	"/get-started/": getStartedPage,
	"/skills": skillsPage,
	"/skills/": skillsPage,
	"/skills/proagentstore-mcp-operator": skillMcpOperatorPage,
	"/skills/proagentstore-mcp-operator/": skillMcpOperatorPage,
	"/docs/browser-runtime": browserRuntimeDocsPage,
	"/docs/browser-runtime/": browserRuntimeDocsPage,
	"/docs/mcp": mcpDocsPage,
	"/docs/mcp/": mcpDocsPage,
	"/console": consolePage,
	"/console/": consolePage,
	"/admin": adminPage,
	"/admin/": adminPage,
	"/changelog": changelogPage,
	"/changelog/": changelogPage,
};

const HTML_HEADERS: Record<string, string> = {
	"Content-Type": "text/html; charset=utf-8",
	"Cache-Control": "public, max-age=300",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

const JS_HEADERS: Record<string, string> = {
	"Content-Type": "application/javascript; charset=utf-8",
	"Cache-Control": "public, max-age=3600",
	"X-Content-Type-Options": "nosniff",
	"Access-Control-Allow-Origin": "*",
};

function b64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const arr = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
	return arr;
}

const ICON_MAP: Record<string, string> = {
	"/icon-16.png": icon16,
	"/icon-32.png": icon32,
	"/icon-180.png": icon180,
	"/icon-192.png": icon192,
	"/icon-512.png": icon512,
	"/apple-touch-icon.png": icon180,
};

export default {
	async fetch(request: Request): Promise<Response> {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		const url = new URL(request.url);
		const path =
			url.hostname === "console.proagentstore.online" && url.pathname === "/"
				? "/console"
				: url.pathname;

		// Static pages
		const page = PAGES[path];
		if (page) return new Response(page, { headers: HTML_HEADERS });

		if (
			path.startsWith("/console/") ||
			(url.hostname === "console.proagentstore.online" && !path.includes("."))
		) {
			return new Response(consolePage, { headers: HTML_HEADERS });
		}

		// JS assets
		if (path === "/widget.js") return new Response(widgetJs, { headers: JS_HEADERS });
		if (path === "/auth-widget.js") return new Response(authWidgetJs, { headers: JS_HEADERS });

		// Favicon
		if (path === "/favicon.svg" || path === "/favicon.ico") {
			return new Response(faviconSvg, {
				headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
			});
		}

		// OpenAPI spec
		if (path === "/openapi.yaml" || path === "/openapi.yml") {
			return new Response(openapiYaml, {
				headers: { "Content-Type": "text/yaml; charset=utf-8", "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "https://proagentstore.online" },
			});
		}

		if (path === "/llms.txt") {
			return new Response(llmsTxt, {
				headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" },
			});
		}

		if (path === "/llms-full.txt") {
			return new Response(llmsFullTxt, {
				headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" },
			});
		}

		if (path === "/skills.json") {
			return new Response(skillsJson, {
				headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" },
			});
		}

		if (path === "/.well-known/mcp-server.json" || path === "/mcp-server.json") {
			return new Response(mcpServerJson, {
				headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" },
			});
		}

		// robots.txt
		if (path === "/robots.txt") {
			return new Response(
				"User-agent: *\nAllow: /\nDisallow: /console/\nDisallow: /admin/\n\nSitemap: https://proagentstore.online/sitemap.xml\nLLMs: https://proagentstore.online/llms.txt\n",
				{ headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=86400" } },
			);
		}

		// Dynamic sitemap — fetches published agents from API
		if (path === "/sitemap.xml") {
			const staticUrls = ["/", "/about/", "/get-started/", "/skills/", "/skills/proagentstore-mcp-operator/", "/docs/mcp/", "/docs/browser-runtime/", "/console/", "/changelog/"];
			let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
			for (const u of staticUrls) {
				xml += `  <url><loc>https://proagentstore.online${u}</loc><changefreq>weekly</changefreq></url>\n`;
			}
			try {
				const res = await fetch("https://api.proagentstore.online/v1/agents");
				const data = await res.json() as { agents?: Array<{ slug: string; creator_login?: string }> };
				const devs = new Set<string>();
				for (const a of data.agents || []) {
					xml += `  <url><loc>https://proagentstore.online/agents/${a.slug}/</loc><changefreq>daily</changefreq></url>\n`;
					if (a.creator_login) devs.add(a.creator_login);
				}
				for (const d of devs) {
					xml += `  <url><loc>https://proagentstore.online/developers/${d}/</loc><changefreq>weekly</changefreq></url>\n`;
				}
			} catch (error) {
				console.warn("Sitemap agent expansion failed", error);
			}
			xml += "</urlset>";
			return new Response(xml, {
				headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" },
			});
		}

		// Manifest
		if (path === "/manifest.json") {
			return new Response(manifestJson, {
				headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" },
			});
		}

		// PNG icons
		const iconB64 = ICON_MAP[path];
		if (iconB64) {
			return new Response(b64ToBytes(iconB64), {
				headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
			});
		}

		// OG image
		if (path === "/og-image.png") {
			return new Response(b64ToBytes(ogImage), {
				headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
			});
		}

		// Agent detail pages
		if (path.match(/^\/agents\/[a-z0-9-]+\/?$/)) {
			return new Response(agentDetailPage, { headers: HTML_HEADERS });
		}

		// Developer profile pages
		if (path.match(/^\/developers\/[a-zA-Z0-9_-]+\/?$/)) {
			return new Response(developerProfilePage, { headers: HTML_HEADERS });
		}

		if (path === "/index.html") {
			return Response.redirect(`${url.origin}/`, 301);
		}

		return new Response(notFoundPage, { status: 404, headers: { ...HTML_HEADERS, "Cache-Control": "no-cache" } });
	},
};
