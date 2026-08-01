import { afterEach, describe, expect, it, vi } from "vitest";
import { getRegistryTool, runRegistryTool } from "../tool-registry.js";
import type { RegistryToolCtx } from "../tool-registry.js";
import type { ConnectorClient } from "./client.js";

// web_search resolved from the REGISTRY (proves it's registered → callable via runtime,
// MCP proxy, and POST …/tools/web_search with no bespoke route).
const webSearch = getRegistryTool("web_search")!;

/** Mock globalThis.fetch (what safeFetch calls). Records the URL + init. */
function mockFetch(status: number, body: unknown) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
		calls.push({ url: String(url), init: init || {} });
		return new Response(typeof body === "string" ? body : JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	});
	return { calls };
}

/** A ctx whose connectorClient("web-search").token() returns the vault key + a cx env. */
function ctxWithKey(key: string, cx = "CSE_ID"): RegistryToolCtx {
	const client = { token: async () => key } as unknown as ConnectorClient;
	return { env: { WEB_SEARCH_CX: cx } as any, connectorClient: () => client } as RegistryToolCtx;
}

function parse(content: string): any {
	try {
		return JSON.parse(content);
	} catch {
		return undefined;
	}
}

afterEach(() => vi.restoreAllMocks());

// A sample Google Custom Search JSON response for "Blue Bottle Cafe Newtown".
const CSE_RESPONSE = {
	items: [
		{ title: "Blue Bottle Cafe (@bluebottle_syd) • Instagram photos", link: "https://www.instagram.com/bluebottle_syd/", snippet: "Newtown, Sydney NSW." },
		{ title: "Blue Bottle Cafe - Home | Facebook", link: "https://www.facebook.com/BlueBottleNewtown", snippet: "Cafe · Newtown. Email hello@bluebottle.example" },
		{ title: "Blue Bottle Cafe", link: "https://bluebottle.example", snippet: "Specialty coffee in Newtown." },
	],
};

describe("web_search — registration & schema", () => {
	it("is registered as a web-search-connector, read-scoped tool", () => {
		expect(webSearch.connector).toBe("web-search");
		expect(webSearch.tier).toBe("connector");
		expect(webSearch.scope).toBe("read");
	});
	it("exposes query/num/cx in its schema and requires query", () => {
		const p = webSearch.jsonSchema.properties;
		for (const k of ["query", "num", "cx"]) expect(p[k]).toBeDefined();
		expect(webSearch.jsonSchema.required).toContain("query");
	});
	it("errors (not throws) when query is empty", async () => {
		const r = await webSearch.handler(ctxWithKey("K"), { query: "" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/query/i);
	});
});

describe("web_search — Google Custom Search wiring", () => {
	it("returns [{title, link, snippet}] for a business query", async () => {
		mockFetch(200, CSE_RESPONSE);
		const r = await webSearch.handler(ctxWithKey("SECRET_KEY"), { query: "Blue Bottle Cafe Newtown", num: 3 });
		expect(r.success).toBe(true);
		const out = parse(r.content);
		expect(out.count).toBe(3);
		expect(out.results[0]).toEqual({
			title: "Blue Bottle Cafe (@bluebottle_syd) • Instagram photos",
			link: "https://www.instagram.com/bluebottle_syd/",
			snippet: "Newtown, Sydney NSW.",
		});
	});
	it("hits the Custom Search endpoint with q, cx, and num", async () => {
		const { calls } = mockFetch(200, CSE_RESPONSE);
		await webSearch.handler(ctxWithKey("SECRET_KEY", "MY_CSE"), { query: "cafe newtown", num: 2 });
		const u = new URL(calls[0].url);
		expect(u.origin + u.pathname).toBe("https://www.googleapis.com/customsearch/v1");
		expect(u.searchParams.get("q")).toBe("cafe newtown");
		expect(u.searchParams.get("cx")).toBe("MY_CSE");
		expect(u.searchParams.get("num")).toBe("2");
	});
	it("a per-call cx overrides the WEB_SEARCH_CX env default", async () => {
		const { calls } = mockFetch(200, CSE_RESPONSE);
		await webSearch.handler(ctxWithKey("K", "ENV_CX"), { query: "x", cx: "CALL_CX" });
		expect(new URL(calls[0].url).searchParams.get("cx")).toBe("CALL_CX");
	});
	it("caps num at 10 and defaults to 5", async () => {
		const { calls } = mockFetch(200, { items: [] });
		await webSearch.handler(ctxWithKey("K"), { query: "x", num: 99 });
		expect(new URL(calls[0].url).searchParams.get("num")).toBe("10");
		await webSearch.handler(ctxWithKey("K"), { query: "y" });
		expect(new URL(calls[1].url).searchParams.get("num")).toBe("5");
	});
	it("no CSE id (no cx, no env) → clean failure, no request", async () => {
		const { calls } = mockFetch(200, {});
		const noCx = { env: {} as any, connectorClient: () => ({ token: async () => "K" }) as any } as RegistryToolCtx;
		const r = await webSearch.handler(noCx, { query: "x" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/cx|WEB_SEARCH_CX/i);
		expect(calls).toHaveLength(0);
	});
});

describe("web_search — api-key from vault, never leaked", () => {
	it("reads the key via connectorClient and injects it into the request URL", async () => {
		const { calls } = mockFetch(200, CSE_RESPONSE);
		await webSearch.handler(ctxWithKey("VAULT_KEY"), { query: "x" });
		expect(new URL(calls[0].url).searchParams.get("key")).toBe("VAULT_KEY");
	});
	it("never echoes the key into the returned result", async () => {
		mockFetch(200, CSE_RESPONSE);
		const r = await webSearch.handler(ctxWithKey("VAULT_KEY"), { query: "x" });
		expect(r.content).not.toContain("VAULT_KEY");
	});
	it("exposes no key input in the schema (the value comes from the vault, not the caller)", () => {
		// The caller can never SUPPLY the key: there is no `key`/`apiKey`/`token` input property.
		// (The description documenting "read from the vault" is intentional; the VALUE is never here.)
		for (const forbidden of ["key", "apiKey", "api_key", "token", "secret"]) {
			expect(webSearch.jsonSchema.properties[forbidden]).toBeUndefined();
		}
		expect(Object.keys(webSearch.jsonSchema.properties).sort()).toEqual(["cx", "num", "query"]);
	});
	it("fails cleanly (no request) when no key is connected", async () => {
		const { calls } = mockFetch(200, {});
		const noKey = { env: { WEB_SEARCH_CX: "CSE" } as any, connectorClient: () => ({ token: async () => "" }) as any } as RegistryToolCtx;
		const r = await webSearch.handler(noKey, { query: "x" });
		expect(r.success).toBe(false);
		expect(calls).toHaveLength(0);
	});
	it("an upstream error does not leak the request URL (which carries the key)", async () => {
		mockFetch(403, { error: { message: "quota" } });
		const r = await webSearch.handler(ctxWithKey("VAULT_KEY"), { query: "x" });
		expect(r.success).toBe(false);
		expect(r.content).not.toContain("VAULT_KEY");
	});
});

describe("web_search — SSRF safety (uses safeFetch)", () => {
	it("only ever targets the Google endpoint (public https) — a mocked SSRF host is impossible via input", async () => {
		// web_search builds the URL itself from the fixed endpoint, so a caller can't redirect it
		// to a private target. Confirm the outbound URL host is always googleapis.com.
		const { calls } = mockFetch(200, { items: [] });
		await webSearch.handler(ctxWithKey("K"), { query: "http://169.254.169.254/latest/meta-data" });
		expect(new URL(calls[0].url).hostname).toBe("www.googleapis.com");
	});
	it("goes through safeFetch — a blocked target surfaces as a failure, not a throw", async () => {
		// Simulate safeFetch rejecting (e.g. a poisoned redirect) by making the underlying fetch throw.
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
		const r = await webSearch.handler(ctxWithKey("K"), { query: "x" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/search failed/i);
	});
});

// ── the #99 acceptance proof: business name+suburb → instagram/facebook/email as config ──
describe("web_search + extract_contacts — enrichment (issue #99 acceptance)", () => {
	it("given a business name+suburb, yields instagram/facebook/email columns (pure config)", async () => {
		mockFetch(200, CSE_RESPONSE);
		const ctx = ctxWithKey("VAULT_KEY");

		// 1) search the web for the business (dispatched through runRegistryTool → audited/granted).
		const search = await runRegistryTool("web_search", ctx, { query: "Blue Bottle Cafe Newtown Sydney" });
		expect(search.success).toBe(true);

		// 2) extract socials + email from the results — no bespoke code, just the step catalog.
		const enriched = await runRegistryTool("extract_contacts", ctx, { items: parse(search.content) });
		expect(enriched.success).toBe(true);

		const cols = parse(enriched.content);
		expect(cols.instagram).toBe("https://instagram.com/bluebottle_syd");
		expect(cols.facebook).toBe("https://facebook.com/BlueBottleNewtown");
		expect(cols.email).toBe("hello@bluebottle.example");
	});
});
