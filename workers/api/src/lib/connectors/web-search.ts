// Web-search connector (issue #99, child of #94/#84). Enriching a lead with its socials +
// email needs a web search — a capability the generic `http` connector can't cleanly cover
// because the search KEY must live in its OWN vault slot (provider "web-search"), separate
// from the http connector's key. So this is a first-class connector: declared once in the
// registry, it provides ONE `web_search` tool.
//
// Auth (declared on the connector as auth:"token", grantModel:"user", no tokenEnv):
//   the Google Custom Search API KEY is read from the vault (user_api_keys, provider
//   "web-search") via ctx.connectorClient("web-search").token(). The key value is used only
//   on the wire — it NEVER appears in the tool inputs, schema, or returned result.
//
// The CSE id (`cx`) is NOT a secret (it identifies the search engine, not the account), so it
// is a plain tool input (or the WEB_SEARCH_CX env default), not a vault secret.
//
// Every request goes through safeFetch (lib/ssrf.ts) — https-only, SSRF-guarded, redirects
// re-validated — the same guard the #95 http connector uses. We do NOT re-implement fetch/SSRF.
import type { ToolDef, RegistryToolCtx } from "../tool-registry.js";
import { safeFetch, SsrfError } from "../ssrf.js";

// Google Custom Search JSON API endpoint. Wrapped, not hardcoded into agent code:
//   GET https://www.googleapis.com/customsearch/v1?key=<vault>&cx=<cse-id>&q=<query>&num=<n>
const CSE_ENDPOINT = "https://www.googleapis.com/customsearch/v1";

// Per-call result cap. Google CSE returns at most 10 items per request; we also cap the
// caller-supplied `num` so a single web_search call can never fan out beyond one page.
const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 5;

interface CseItem {
	title?: string;
	link?: string;
	snippet?: string;
}

export const WEB_SEARCH_TOOLS: ToolDef[] = [
	{
		name: "web_search",
		tier: "connector",
		connector: "web-search",
		scope: "read",
		description:
			"Search the web (Google Custom Search) for a query and return the top results as [{title, link, snippet}]. Use it to look a business up by name+suburb before an extract step pulls its Instagram/Facebook/email. The API key is read from the vault (never passed in); supply the non-secret CSE id via `cx` (or the WEB_SEARCH_CX env default). `num` caps results (default 5, max 10). Results are best-effort. HTTPS-only, SSRF-guarded.",
		jsonSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "The search query, e.g. 'Blue Bottle Cafe Newtown Sydney instagram'." },
				num: { type: "number", description: "Number of results to return (default 5, max 10)." },
				cx: { type: "string", description: "Google Custom Search engine id (cx). Not a secret — defaults to the WEB_SEARCH_CX env if omitted." },
			},
			required: ["query"],
		},
		handler: async (ctx: RegistryToolCtx, input) => {
			const query = String(input.query ?? "").trim();
			if (!query) return { content: "query is required.", success: false };

			// cx: non-secret search-engine id. Tool input takes precedence, else the env default.
			const cx = (typeof input.cx === "string" && input.cx.trim()) || ctx.env?.WEB_SEARCH_CX?.trim() || "";
			if (!cx) return { content: "No Custom Search engine id — pass `cx` or set WEB_SEARCH_CX.", success: false };

			const num = Math.max(1, Math.min(Number(input.num) || DEFAULT_RESULTS, MAX_RESULTS));

			// The API key comes from the vault via the connectorClient (provider "web-search").
			// It is attached to the outgoing URL only — never returned or logged.
			const key = await ctx.connectorClient?.("web-search").token().catch(() => null);
			if (!key) return { content: "No API key connected for the web-search connector — add one in the instance's Connections settings.", success: false };

			const u = new URL(CSE_ENDPOINT);
			u.searchParams.set("key", key);
			u.searchParams.set("cx", cx);
			u.searchParams.set("q", query);
			u.searchParams.set("num", String(num));

			let res: Response;
			try {
				res = await safeFetch(u.toString(), { method: "GET" });
			} catch (e) {
				if (e instanceof SsrfError) return { content: `Blocked: ${e.message}`, success: false };
				return { content: `Search failed: ${e instanceof Error ? e.message : String(e)}`, success: false };
			}

			const text = await res.text();
			let body: unknown = text;
			try {
				body = JSON.parse(text);
			} catch {
				/* keep as text */
			}
			if (!res.ok) {
				// Surface the status but NOT the request URL (which carries the key).
				const msg = body && typeof body === "object" ? JSON.stringify((body as { error?: unknown }).error ?? body) : String(body);
				return { content: `Search error ${res.status}: ${msg}`.slice(0, 500), success: false };
			}

			const rawItems = (body && typeof body === "object" ? (body as { items?: unknown }).items : undefined);
			const items: CseItem[] = Array.isArray(rawItems) ? rawItems : [];
			const results = items.slice(0, num).map((it) => ({
				title: typeof it.title === "string" ? it.title : "",
				link: typeof it.link === "string" ? it.link : "",
				snippet: typeof it.snippet === "string" ? it.snippet : "",
			}));

			return { content: JSON.stringify({ query, count: results.length, results }, null, 2), success: true };
		},
	},
];
