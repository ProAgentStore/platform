/**
 * ProAgentStore host worker — serves marketing pages, console, agent details, widget.
 * Pages are inlined from store/ at build time via build.js → pages.ts.
 */
import {
	aboutPage,
	agentDetailPage,
	authWidgetJs,
	consolePage,
	developerProfilePage,
	getStartedPage,
	homepage,
	widgetJs,
} from "./pages.js";

const PAGES: Record<string, string> = {
	"/": homepage,
	"/about": aboutPage,
	"/about/": aboutPage,
	"/get-started": getStartedPage,
	"/get-started/": getStartedPage,
	"/console": consolePage,
	"/console/": consolePage,
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

export default {
	async fetch(request: Request): Promise<Response> {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		const url = new URL(request.url);
		const path = url.pathname;

		// Static pages
		const page = PAGES[path];
		if (page) return new Response(page, { headers: HTML_HEADERS });

		// JS assets
		if (path === "/widget.js") {
			return new Response(widgetJs, { headers: JS_HEADERS });
		}
		if (path === "/auth-widget.js") {
			return new Response(authWidgetJs, { headers: JS_HEADERS });
		}

		// Agent detail pages: /agents/{slug} or /agents/{slug}/
		if (path.match(/^\/agents\/[a-z0-9-]+\/?$/)) {
			return new Response(agentDetailPage, { headers: HTML_HEADERS });
		}

		// Developer profile pages: /developers/{login} or /developers/{login}/
		if (path.match(/^\/developers\/[a-zA-Z0-9_-]+\/?$/)) {
			return new Response(developerProfilePage, { headers: HTML_HEADERS });
		}

		if (path === "/index.html") {
			return Response.redirect(`${url.origin}/`, 301);
		}

		return new Response("Not Found", {
			status: 404,
			headers: { "Content-Type": "text/plain" },
		});
	},
};
