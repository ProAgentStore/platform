/**
 * ProAgentStore host worker — serves pages, assets, console, widget.
 * Pages inlined from store/ at build time via build.js → pages.ts.
 */
import {
	homepage, aboutPage, getStartedPage, consolePage, agentDetailPage,
	widgetJs, authWidgetJs, developerProfilePage,
	faviconSvg, manifestJson,
	icon16, icon32, icon180, icon192, icon512, ogImage,
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
		const path = url.pathname;

		// Static pages
		const page = PAGES[path];
		if (page) return new Response(page, { headers: HTML_HEADERS });

		// JS assets
		if (path === "/widget.js") return new Response(widgetJs, { headers: JS_HEADERS });
		if (path === "/auth-widget.js") return new Response(authWidgetJs, { headers: JS_HEADERS });

		// Favicon
		if (path === "/favicon.svg" || path === "/favicon.ico") {
			return new Response(faviconSvg, {
				headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
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

		return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
	},
};
