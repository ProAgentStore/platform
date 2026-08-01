import { afterEach, describe, expect, it, vi } from "vitest";
import { getRegistryTool } from "../tool-registry.js";
import type { RegistryToolCtx } from "../tool-registry.js";
import type { ConnectorClient } from "./client.js";

// The http_request tool, resolved from the registry (proves it's registered → callable via
// runtime, MCP proxy, and POST …/tools/http_request with no bespoke route).
const httpRequest = getRegistryTool("http_request")!;

// A ctx with no vault (api-key tests inject their own connectorClient).
const baseCtx = { env: {} as any } as RegistryToolCtx;

/** Mock globalThis.fetch (what safeFetch calls). Records the URL + init it was given. */
function mockFetch(status: number, body: unknown) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
		calls.push({ url: String(url), init: init || {} });
		return new Response(typeof body === "string" ? body : JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	});
	return { calls, spy };
}

afterEach(() => vi.restoreAllMocks());

async function run(input: Record<string, unknown>, ctx: RegistryToolCtx = baseCtx) {
	const r = await httpRequest.handler(ctx, input);
	return { ...r, parsed: r.success || r.content.startsWith("{") ? safeParse(r.content) : undefined };
}
function safeParse(s: string): any {
	try {
		return JSON.parse(s);
	} catch {
		return undefined;
	}
}

describe("http_request — registration & schema", () => {
	it("is registered as an http-connector, read-scoped tool", () => {
		expect(httpRequest.connector).toBe("http");
		expect(httpRequest.tier).toBe("connector");
		expect(httpRequest.scope).toBe("read");
	});
	it("exposes method/url/base/path/query/headers/body/auth/responseMap/pagination in its schema", () => {
		const p = httpRequest.jsonSchema.properties;
		for (const k of ["method", "url", "base", "path", "query", "headers", "body", "auth", "responseMap", "pagination"]) {
			expect(p[k]).toBeDefined();
		}
		expect(httpRequest.jsonSchema.type).toBe("object");
	});
	it("errors (not throws) when neither url nor base is supplied", async () => {
		const r = await run({ method: "GET" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/url.*base/i);
	});
});

describe("http_request — {{param}} interpolation", () => {
	it("interpolates url, query, headers, and body from inputs", async () => {
		const { calls } = mockFetch(200, { ok: true });
		await run({
			method: "POST",
			url: "https://api.example.com/{{version}}/search",
			query: { q: "{{term}}" },
			headers: { "X-Trace": "{{trace}}" },
			body: { text: "{{term}}", n: "{{limit}}" },
			inputs: { version: "v1", term: "coffee", trace: "abc", limit: 5 },
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.example.com/v1/search?q=coffee");
		expect((calls[0].init.headers as Headers).get("X-Trace")).toBe("abc");
		expect(JSON.parse(calls[0].init.body as string)).toEqual({ text: "coffee", n: "5" });
	});
	it("joins base + path and drops empty query params", async () => {
		const { calls } = mockFetch(200, {});
		await run({ base: "https://api.example.com/", path: "/v1/thing", query: { a: "", b: "keep" } });
		expect(calls[0].url).toBe("https://api.example.com/v1/thing?b=keep");
	});
	it("a missing input renders as empty, not the literal {{x}}", async () => {
		const { calls } = mockFetch(200, {});
		await run({ url: "https://api.example.com/x?p={{missing}}" });
		expect(calls[0].url).not.toContain("{{");
	});
});

describe("http_request — responseMap extraction", () => {
	const places = {
		places: [
			{ id: "1", displayName: { text: "Cafe A" }, websiteUri: "https://a.example" },
			{ id: "2", displayName: { text: "Cafe B" }, websiteUri: null },
		],
		nextPageToken: "TOKEN123",
	};
	it("projects an array with a reshape spec (aliased dotted sub-paths)", async () => {
		mockFetch(200, places);
		const r = await run({
			url: "https://places.example/search",
			responseMap: "places[].{id,name:displayName.text,site:websiteUri}",
		});
		expect(r.parsed.data).toEqual([
			{ id: "1", name: "Cafe A", site: "https://a.example" },
			{ id: "2", name: "Cafe B", site: null },
		]);
	});
	it("resolves a plain dotted path (with array index)", async () => {
		mockFetch(200, places);
		const r = await run({ url: "https://places.example/search", responseMap: "places.0.displayName.text" });
		expect(r.parsed.data).toBe("Cafe A");
	});
	it("returns raw body alongside mapped data when includeRaw is set", async () => {
		mockFetch(200, places);
		const r = await run({ url: "https://places.example/search", responseMap: "places[].id", includeRaw: true });
		expect(r.parsed.data).toEqual(["1", "2"]);
		expect(r.parsed.raw.nextPageToken).toBe("TOKEN123");
	});
});

describe("http_request — pagination descriptor", () => {
	it("surfaces the next-page marker as nextCursor", async () => {
		mockFetch(200, { items: [], nextPageToken: "PAGE2" });
		const r = await run({
			url: "https://api.example.com/list",
			pagination: { type: "nextPageToken", path: "nextPageToken" },
		});
		expect(r.parsed.nextCursor).toBe("PAGE2");
		expect(r.parsed.paginationType).toBe("nextPageToken");
	});
	it("nextCursor is null when the marker is absent", async () => {
		mockFetch(200, { items: [] });
		const r = await run({ url: "https://api.example.com/list", pagination: { type: "offset", path: "next" } });
		expect(r.parsed.nextCursor).toBeNull();
	});
});

describe("http_request — api-key from vault (mocked connectorClient)", () => {
	// A connectorClient whose token() returns the vault key. Asserts the KEY never appears
	// in inputs/schema and is injected onto the wire only.
	function ctxWithKey(key: string): RegistryToolCtx {
		const client = { token: async () => key } as unknown as ConnectorClient;
		return { env: {} as any, connectorClient: () => client } as RegistryToolCtx;
	}
	it("injects the vault key into a configurable request header (Google Places X-Goog-Api-Key)", async () => {
		const { calls } = mockFetch(200, { places: [] });
		await run(
			{ url: "https://places.googleapis.com/v1/places:searchText", method: "POST", auth: { mode: "api-key", key: { in: "header", name: "X-Goog-Api-Key" } }, body: {} },
			ctxWithKey("SECRET_KEY"),
		);
		expect((calls[0].init.headers as Headers).get("X-Goog-Api-Key")).toBe("SECRET_KEY");
	});
	it("injects the vault key into a configurable query param", async () => {
		const { calls } = mockFetch(200, {});
		await run(
			{ url: "https://maps.googleapis.com/maps/api/geocode/json?address=Sydney", auth: { mode: "api-key", key: { in: "query", name: "key" } } },
			ctxWithKey("SECRET_KEY"),
		);
		expect(calls[0].url).toContain("key=SECRET_KEY");
	});
	it("fails cleanly (no request) when api-key mode is set but no key is connected", async () => {
		const { calls } = mockFetch(200, {});
		const noKey = { env: {} as any, connectorClient: () => ({ token: async () => "" }) as any } as RegistryToolCtx;
		const r = await run({ url: "https://places.googleapis.com/v1/x", auth: { mode: "api-key", key: { in: "header", name: "X-Goog-Api-Key" } } }, noKey);
		expect(r.success).toBe(false);
		expect(calls).toHaveLength(0);
	});
	it("never echoes the key into the returned result", async () => {
		mockFetch(200, { ok: true });
		const r = await run(
			{ url: "https://places.googleapis.com/v1/x", auth: { mode: "api-key", key: { in: "header", name: "X-Goog-Api-Key" } } },
			ctxWithKey("SECRET_KEY"),
		);
		expect(r.content).not.toContain("SECRET_KEY");
	});
});

describe("http_request — SSRF safety (uses safeFetch)", () => {
	it("rejects a non-public target without hitting the network", async () => {
		const { calls } = mockFetch(200, {});
		const r = await run({ url: "https://169.254.169.254/latest/meta-data/" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/blocked/i);
		expect(calls).toHaveLength(0); // safeFetch threw SsrfError before fetching
	});
	it("rejects an http:// (non-https) URL", async () => {
		const { calls } = mockFetch(200, {});
		const r = await run({ url: "http://api.example.com/x" });
		expect(r.success).toBe(false);
		expect(calls).toHaveLength(0);
	});
});

describe("http_request — Google Places searchText, purely as config (the #95 proof)", () => {
	it("expresses a full Places searchText call — url, key-from-vault, JSON body, responseMap — with zero bespoke code", async () => {
		const placesResponse = {
			places: [
				{ id: "p1", displayName: { text: "Blue Bottle" }, websiteUri: "https://bluebottle.example" },
				{ id: "p2", displayName: { text: "No Site Cafe" } },
			],
		};
		const { calls } = mockFetch(200, placesResponse);
		const client = { token: async () => "PLACES_KEY" } as unknown as ConnectorClient;
		const ctx = { env: {} as any, connectorClient: () => client } as RegistryToolCtx;

		const r = await run(
			{
				method: "POST",
				url: "https://places.googleapis.com/v1/places:searchText",
				auth: { mode: "api-key", key: { in: "header", name: "X-Goog-Api-Key" } },
				headers: { "X-Goog-FieldMask": "places.id,places.displayName,places.websiteUri" },
				body: { textQuery: "{{query}}", maxResultCount: "{{max}}" },
				inputs: { query: "cafes in Sydney", max: 20 },
				responseMap: "places[].{id,name:displayName.text,site:websiteUri}",
			},
			ctx,
		);

		// Right endpoint, method, auth header, field mask, and templated JSON body.
		expect(calls[0].url).toBe("https://places.googleapis.com/v1/places:searchText");
		expect(calls[0].init.method).toBe("POST");
		const h = calls[0].init.headers as Headers;
		expect(h.get("X-Goog-Api-Key")).toBe("PLACES_KEY");
		expect(h.get("X-Goog-FieldMask")).toBe("places.id,places.displayName,places.websiteUri");
		expect(JSON.parse(calls[0].init.body as string)).toEqual({ textQuery: "cafes in Sydney", maxResultCount: "20" });

		// Mapped result — exactly the typed shape a lead-finder source step consumes.
		expect(r.success).toBe(true);
		expect(r.parsed.status).toBe(200);
		expect(r.parsed.data).toEqual([
			{ id: "p1", name: "Blue Bottle", site: "https://bluebottle.example" },
			{ id: "p2", name: "No Site Cafe", site: null },
		]);
	});
});
