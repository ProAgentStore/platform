import { afterEach, describe, expect, it, vi } from "vitest";
import { getRegistryTool, runRegistryTool } from "./tool-registry.js";
import type { RegistryToolCtx } from "./tool-registry.js";
import type { ConnectorClient } from "./connectors/client.js";

// Resolve steps from the REGISTRY — proves each is registered (dispatchable via
// runRegistryTool for the #97 runner, and via POST …/tools/:name with no bespoke route).
const mapT = getRegistryTool("map")!;
const filterT = getRegistryTool("filter")!;
const flattenT = getRegistryTool("flatten")!;
const dedupeT = getRegistryTool("dedupe_upsert")!;
const fanOutT = getRegistryTool("fan_out")!;
const enrichT = getRegistryTool("enrich")!;
const reachableT = getRegistryTool("http_reachable")!;
const geocodeT = getRegistryTool("geocode")!;
const extractT = getRegistryTool("extract_contacts")!;

const baseCtx = { env: {} as any } as RegistryToolCtx;

function parse(content: string): any {
	return JSON.parse(content);
}

afterEach(() => vi.restoreAllMocks());

// ── registration ──────────────────────────────────────────────────────────────
describe("step library — registration", () => {
	it("registers all steps as standard-tier, non-connector tools", () => {
		for (const t of [mapT, filterT, flattenT, dedupeT, fanOutT, enrichT, reachableT, geocodeT, extractT]) {
			expect(t).toBeDefined();
			expect(t.tier).toBe("standard");
			expect(t.connector).toBeUndefined();
			expect(t.jsonSchema.type).toBe("object");
		}
	});
});

// ── 1. map ─────────────────────────────────────────────────────────────────────
describe("map", () => {
	it("extracts nested address components (the lead-finder reshape)", async () => {
		const r = await mapT.handler(baseCtx, {
			items: [{
				place_id: "p1",
				addressComponents: { locality: "Sydney", sublocality: "Newtown", state: "NSW", country: "Australia" },
			}],
			extract: {
				city: "addressComponents.locality",
				suburb: "addressComponents.sublocality",
				state: "addressComponents.state",
				country: "addressComponents.country",
			},
			keep: ["place_id"],
		});
		const out = parse(r.content).items[0];
		expect(out).toEqual({ place_id: "p1", city: "Sydney", suburb: "Newtown", state: "NSW", country: "Australia" });
	});

	it("renames fields, derives constants, builds nested output paths", async () => {
		const r = await mapT.handler(baseCtx, {
			items: [{ displayName: { text: "Cafe" }, websiteUri: "https://x.test" }],
			rename: { "displayName.text": "name", websiteUri: "geo.site" },
			derive: { source: "places" },
		});
		const out = parse(r.content).items[0];
		expect(out.name).toBe("Cafe");
		expect(out.geo).toEqual({ site: "https://x.test" });
		expect(out.source).toBe("places");
	});

	it("missing nested path → null, and treats a single object as one item", async () => {
		const r = await mapT.handler(baseCtx, { items: { a: 1 }, extract: { b: "nope.deep" } });
		const parsed = parse(r.content);
		expect(parsed.count).toBe(1);
		expect(parsed.items[0].b).toBeNull();
	});
});

// ── 2. filter ───────────────────────────────────────────────────────────────────
describe("filter", () => {
	const leads = [
		{ id: 1, websiteUri: undefined, reachable: undefined }, // no website
		{ id: 2, websiteUri: "https://a.test", reachable: false }, // has site but dead
		{ id: 3, websiteUri: "https://b.test", reachable: true }, // healthy — drop
	];

	it("keeps 'no-website OR unreachable' (the lead-finder predicate)", async () => {
		const r = await filterT.handler(baseCtx, {
			items: leads,
			any: true,
			where: [
				{ field: "websiteUri", op: "missing" },
				{ field: "reachable", op: "eq", value: false },
			],
		});
		const kept = parse(r.content).items.map((x: any) => x.id);
		expect(kept).toEqual([1, 2]);
	});

	it("AND semantics + numeric ops", async () => {
		const r = await filterT.handler(baseCtx, {
			items: [{ score: 5, active: true }, { score: 1, active: true }, { score: 9, active: false }],
			where: [{ field: "score", op: "gte", value: 5 }, { field: "active", op: "truthy" }],
		});
		expect(parse(r.content).items).toEqual([{ score: 5, active: true }]);
	});

	it("mode:drop inverts the predicate", async () => {
		const r = await filterT.handler(baseCtx, {
			items: [{ x: 1 }, { x: 2 }],
			mode: "drop",
			where: [{ field: "x", op: "eq", value: 1 }],
		});
		expect(parse(r.content).items).toEqual([{ x: 2 }]);
		expect(parse(r.content).dropped).toBe(1);
	});
});

// ── 2b. flatten (issue #113) ───────────────────────────────────────────────────
describe("flatten", () => {
	it("collapses an array-of-arrays (grid fan-out result) into one flat record list", async () => {
		// The exact grid shape: one page of places per cell → [[…],[…]].
		const aoa = [[{ place_id: "a" }], [{ place_id: "b" }, { place_id: "c" }]];
		const r = await flattenT.handler(baseCtx, { items: aoa });
		const parsed = parse(r.content);
		expect(parsed.count).toBe(3); // 3 places, NOT 2 cells (the GAP #1 fix)
		expect(parsed.items.map((x: any) => x.place_id)).toEqual(["a", "b", "c"]);
	});

	it("default depth 1 leaves deeper nesting intact; depth:2 flattens further", async () => {
		const nested = [[[1], [2]], [[3]]];
		expect(parse((await flattenT.handler(baseCtx, { items: nested })).content).items).toEqual([[1], [2], [3]]);
		expect(parse((await flattenT.handler(baseCtx, { items: nested, depth: 2 })).content).items).toEqual([1, 2, 3]);
	});

	it("depth:0 is a no-op copy; a flat array passes through unchanged", async () => {
		expect(parse((await flattenT.handler(baseCtx, { items: [[1], [2]], depth: 0 })).content).items).toEqual([[1], [2]]);
		expect(parse((await flattenT.handler(baseCtx, { items: [1, 2, 3] })).content).items).toEqual([1, 2, 3]);
	});

	it("path lifts a sub-array from each envelope before concatenating (per-cell http_request results)", async () => {
		// The real grid shape: a forEach binds one http_request {status,data:[…]} per cell.
		const perCell = [
			{ status: 200, data: [{ place_id: "a" }] },
			{ status: 200, data: [{ place_id: "b" }, { place_id: "c" }] },
		];
		const r = await flattenT.handler(baseCtx, { items: perCell, path: "data" });
		expect(parse(r.content).items.map((x: any) => x.place_id)).toEqual(["a", "b", "c"]);
	});
});

// ── 3. dedupe_upsert ─────────────────────────────────────────────────────────────
// Mock the instance DO: GET records?where= returns a seen map keyed by place_id; POST
// inserts; PUT updates. Proves insert-vs-update routing + that we never double-insert a
// key that already exists (respecting the collection's unique constraint).
function mockAgentStub(seen: Record<string, string>) {
	const calls: Array<{ method: string; url: string; body?: any }> = [];
	const fetch = vi.fn(async (req: Request) => {
		const url = new URL(req.url);
		const method = req.method;
		const body = method === "GET" ? undefined : await req.clone().json().catch(() => undefined);
		calls.push({ method, url: url.pathname + url.search, body });
		if (method === "GET") {
			const where = JSON.parse(url.searchParams.get("where") || "{}");
			const kv = String(Object.values(where)[0]);
			const id = seen[kv];
			return new Response(JSON.stringify({ records: id ? [{ id }] : [], total: id ? 1 : 0 }), { status: 200 });
		}
		if (method === "POST") return new Response(JSON.stringify({ id: "new1" }), { status: 201 });
		if (method === "PUT") return new Response(JSON.stringify({ id: "existing" }), { status: 200 });
		return new Response("no", { status: 404 });
	});
	const env = { AGENT: { idFromName: (n: string) => n, get: () => ({ fetch }) } } as any;
	return { env, calls };
}

describe("dedupe_upsert", () => {
	it("inserts unseen keys and updates-in-place seen keys (unique key respected)", async () => {
		const { env, calls } = mockAgentStub({ p_existing: "existing" });
		const ctx = { env, instanceId: "inst1" } as RegistryToolCtx;
		const r = await dedupeT.handler(ctx, {
			collection: "leads",
			key: "place_id",
			items: [{ place_id: "p_new", name: "A" }, { place_id: "p_existing", name: "B" }],
		});
		const res = parse(r.content);
		expect(res).toMatchObject({ inserted: 1, updated: 1, skipped: 0 });
		// The seen key went through PUT (update), never POST — so no duplicate insert.
		expect(calls.some((c) => c.method === "PUT")).toBe(true);
		expect(calls.filter((c) => c.method === "POST").length).toBe(1);
	});

	it("mode:skip leaves seen keys untouched", async () => {
		const { env, calls } = mockAgentStub({ p1: "existing" });
		const ctx = { env, instanceId: "inst1" } as RegistryToolCtx;
		const r = await dedupeT.handler(ctx, {
			collection: "leads", key: "place_id", mode: "skip",
			items: [{ place_id: "p1", name: "A" }],
		});
		expect(parse(r.content)).toMatchObject({ inserted: 0, updated: 0, skipped: 1 });
		expect(calls.some((c) => c.method === "PUT")).toBe(false);
	});

	it("items missing the key are skipped, not inserted", async () => {
		const { env } = mockAgentStub({});
		const ctx = { env, instanceId: "inst1" } as RegistryToolCtx;
		const r = await dedupeT.handler(ctx, { collection: "leads", key: "place_id", items: [{ name: "no key" }] });
		expect(parse(r.content)).toMatchObject({ inserted: 0, skipped: 1 });
	});

	it("fails cleanly without instance context", async () => {
		const r = await dedupeT.handler(baseCtx, { collection: "leads", key: "place_id", items: [] });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/instance/i);
	});
});

// ── 4. fan_out ────────────────────────────────────────────────────────────────
describe("fan_out — grid", () => {
	it("yields (2n+1)² cell centres around a centre", async () => {
		const r = await fanOutT.handler(baseCtx, {
			mode: "grid", center: { lat: -33.87, lng: 151.21 }, extentKm: 2, stepKm: 1,
		});
		const parsed = parse(r.content);
		// extent 2 / step 1 → steps=2 → (2*2+1)^2 = 25 cells
		expect(parsed.count).toBe(25);
		// centre cell present
		expect(parsed.cells).toContainEqual({ lat: -33.87, lng: 151.21 });
	});

	it("errors without a valid centre", async () => {
		const r = await fanOutT.handler(baseCtx, { mode: "grid" });
		expect(r.success).toBe(false);
	});
});

describe("fan_out — pages (cursor drive + concurrency cap)", () => {
	it("drives http_request's nextCursor across pages and aggregates items", async () => {
		// Mock the underlying fetch that http_request → safeFetch calls: two pages then a
		// null cursor. Also asserts the cursor is threaded into the request inputs.
		const seenTokens: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (u: any) => {
			const url = new URL(String(u));
			const token = url.searchParams.get("pageToken") || "";
			seenTokens.push(token);
			const page = token === "" ? { items: [{ id: 1 }, { id: 2 }], next: "T2" }
				: token === "T2" ? { items: [{ id: 3 }], next: null }
					: { items: [], next: null };
			return new Response(JSON.stringify(page), { status: 200, headers: { "Content-Type": "application/json" } });
		});
		const ctx = {
			env: {} as any,
			connectorClient: (() => ({}) as unknown as ConnectorClient) as any,
		} as RegistryToolCtx;
		const r = await fanOutT.handler(ctx, {
			mode: "pages",
			cursorParam: "pageToken",
			itemsPath: "data.items",
			maxPages: 5,
			request: {
				method: "GET",
				url: "https://api.test/search",
				query: { pageToken: "{{pageToken}}" },
				responseMap: "", // keep full body → data = raw
				pagination: { type: "nextPageToken", path: "next" },
			},
		});
		const parsed = parse(r.content);
		expect(parsed.count).toBe(3); // 2 + 1 aggregated
		expect(parsed.pages).toBe(2);
		expect(seenTokens).toEqual(["", "T2"]); // first page empty cursor, second threaded
	});

	it("caps at maxPages even if the cursor never ends", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			new Response(JSON.stringify({ items: [{ id: 1 }], next: "always" }), { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		const ctx = { env: {} as any, connectorClient: (() => ({}) as unknown as ConnectorClient) as any } as RegistryToolCtx;
		const r = await fanOutT.handler(ctx, {
			mode: "pages", cursorParam: "pageToken", itemsPath: "data.items", maxPages: 3,
			request: { method: "GET", url: "https://api.test/s", query: { pageToken: "{{pageToken}}" }, pagination: { type: "nextPageToken", path: "next" } },
		});
		expect(parse(r.content).pages).toBe(3);
	});
});

// ── 4b. enrich (issue #115) ─────────────────────────────────────────────────────
describe("enrich", () => {
	it("runs a tool per item ($item template) and merges each result under `as` (via a pure tool)", async () => {
		// enrich with the pure `map` tool: derive a constant per item, written under `tag`.
		const r = await enrichT.handler(baseCtx, {
			items: [{ id: 1 }, { id: 2 }],
			tool: "map",
			input: { items: [{}], derive: { flag: "x" } },
			as: "tag",
		});
		const parsed = parse(r.content);
		expect(parsed.count).toBe(2);
		// original fields preserved on a COPY; the tool result lands under `as`.
		expect(parsed.items[0].id).toBe(1);
		expect(parsed.items[0].tag).toMatchObject({ count: 1 });
	});

	it("the reachability enrich-merge (the lead-finder 'is this site up' half)", async () => {
		// enrich with http_reachable; {$item:"websiteUri"} feeds each item's url. Mock the wire:
		// one live site, one dead host.
		vi.spyOn(globalThis, "fetch").mockImplementation(async (u: any) => {
			if (String(u).includes("live")) return new Response("hi", { status: 200 });
			throw new Error("ECONNREFUSED");
		});
		const r = await enrichT.handler(baseCtx, {
			items: [
				{ place_id: "a", websiteUri: "https://live.test" },
				{ place_id: "b", websiteUri: "https://dead.test" },
			],
			tool: "http_reachable",
			input: { url: { $item: "websiteUri" }, timeoutMs: 500 },
			as: "reachable",
			concurrency: 2,
		});
		const items = parse(r.content).items;
		// each place now carries {ok,code} under `reachable` — correlated to ITS url.
		expect(items.find((x: any) => x.place_id === "a").reachable).toMatchObject({ ok: true, code: 200 });
		expect(items.find((x: any) => x.place_id === "b").reachable).toMatchObject({ ok: false, code: null });
	});

	it("filter can then test the merged field → 'keep no-website OR unreachable' fully composes", async () => {
		// The enrich output above, run through filter with the OR predicate.
		const enriched = [
			{ place_id: "a", websiteUri: undefined, reachable: undefined }, // no website
			{ place_id: "b", websiteUri: "https://x", reachable: { ok: false } }, // dead
			{ place_id: "c", websiteUri: "https://y", reachable: { ok: true } }, // healthy → drop
		];
		const r = await filterT.handler(baseCtx, {
			items: enriched,
			any: true,
			where: [
				{ field: "websiteUri", op: "missing" },
				{ field: "reachable.ok", op: "eq", value: false },
			],
		});
		expect(parse(r.content).items.map((x: any) => x.place_id)).toEqual(["a", "b"]);
	});

	it("fails without tool/as", async () => {
		expect((await enrichT.handler(baseCtx, { items: [{ a: 1 }], as: "x" } as any)).success).toBe(false);
		expect((await enrichT.handler(baseCtx, { items: [{ a: 1 }], tool: "map" } as any)).success).toBe(false);
	});
});

// ── 5. http_reachable ────────────────────────────────────────────────────────────
describe("http_reachable", () => {
	it("classifies a live server (200) as ok with its code", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("hi", { status: 200 }));
		const r = await reachableT.handler(baseCtx, { url: "https://live.test" });
		expect(parse(r.content)).toEqual({ ok: true, code: 200 });
	});

	it("a 403 is still 'up' (live server refusing) → ok:true", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 403 }));
		expect(parse((await reachableT.handler(baseCtx, { url: "https://forbidden.test" })).content)).toEqual({ ok: true, code: 403 });
	});

	it("a 5xx server error → ok:false with the code", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 503 }));
		expect(parse((await reachableT.handler(baseCtx, { url: "https://broken.test" })).content)).toMatchObject({ ok: false, code: 503 });
	});

	it("a dead host (transport error) → ok:false, code:null, and retried once", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
		const r = await reachableT.handler(baseCtx, { url: "https://dead.test", timeoutMs: 500 });
		expect(parse(r.content)).toMatchObject({ ok: false, code: null });
		expect(spy).toHaveBeenCalledTimes(2); // initial + one retry
	});

	it("a blocked/private target is rejected before any fetch (SSRF via safeFetch)", async () => {
		const spy = vi.spyOn(globalThis, "fetch");
		const r = await reachableT.handler(baseCtx, { url: "http://169.254.169.254/latest/meta-data" });
		expect(parse(r.content).ok).toBe(false);
		expect(spy).not.toHaveBeenCalled();
	});
});

// ── 6. geocode ────────────────────────────────────────────────────────────────
describe("geocode", () => {
	it("extracts lat/lng/country/state/locality from a Places Text Search response (via http_request/#95)", async () => {
		// Mock the wire fetch that http_request → safeFetch performs; also confirm the vault
		// key is injected (connectorClient.token() supplies it) as the X-Goog-Api-Key header
		// and the address rides in the POST body — Places (New), not the classic Geocoding API.
		let calledUrl = "";
		let calledKey = "";
		let calledBody = "";
		vi.spyOn(globalThis, "fetch").mockImplementation(async (u: any, init?: any) => {
			const req = u instanceof Request ? u : new Request(String(u), init);
			calledUrl = req.url;
			calledKey = req.headers.get("X-Goog-Api-Key") || "";
			calledBody = await req.clone().text().catch(() => "");
			return new Response(JSON.stringify({
				places: [{
					formattedAddress: "Sydney NSW, Australia",
					location: { latitude: -33.8688, longitude: 151.2093 },
					addressComponents: [
						{ longText: "Sydney", types: ["locality"] },
						{ longText: "New South Wales", types: ["administrative_area_level_1"] },
						{ longText: "Australia", types: ["country"] },
					],
				}],
			}), { status: 200, headers: { "Content-Type": "application/json" } });
		});
		const ctx = {
			env: {} as any,
			instanceId: "inst1",
			connectorClient: ((provider: string) => ({
				connector: { id: provider } as any,
				token: async () => "VAULT_KEY",
				requireGrant: async () => ({}) as any,
				fetch: async () => new Response(""),
			})) as any,
		} as RegistryToolCtx;
		const r = await geocodeT.handler(ctx, { address: "Sydney, NSW" });
		expect(r.success).toBe(true);
		expect(parse(r.content)).toEqual({
			lat: -33.8688, lng: 151.2093, country: "Australia", state: "New South Wales", locality: "Sydney",
			formatted: "Sydney NSW, Australia",
		});
		expect(calledUrl).toContain("places:searchText");
		expect(calledKey).toBe("VAULT_KEY"); // vault key injected as X-Goog-Api-Key header by #95's http_request
		expect(calledBody).toContain("Sydney"); // textQuery in the POST body
	});

	it("no results → clean failure", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			new Response(JSON.stringify({ places: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		const ctx = {
			env: {} as any, instanceId: "inst1",
			connectorClient: (() => ({ token: async () => "K" }) as unknown as ConnectorClient) as any,
		} as RegistryToolCtx;
		const r = await geocodeT.handler(ctx, { address: "Nowhereville" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/no geocode result/i);
	});

	it("rejects an unsupported provider", async () => {
		const ctx = { env: {} as any, connectorClient: (() => ({}) as unknown as ConnectorClient) as any } as RegistryToolCtx;
		const r = await geocodeT.handler(ctx, { address: "x", provider: "bing" });
		expect(r.success).toBe(false);
	});
});

// ── 7. extract_contacts ──────────────────────────────────────────────────────────
describe("extract_contacts", () => {
	it("pulls instagram/facebook/email from web_search-style rows", async () => {
		const rows = [
			{ title: "Blue Bottle Cafe (@bluebottle_syd) • Instagram", link: "https://www.instagram.com/bluebottle_syd/", snippet: "Newtown, Sydney" },
			{ title: "Blue Bottle Cafe | Facebook", link: "https://www.facebook.com/BlueBottleNewtown", snippet: "Cafe in Newtown" },
			{ title: "Contact us", link: "https://bluebottle.example/contact", snippet: "Email hello@bluebottle.example or call…" },
		];
		const r = await extractT.handler(baseCtx, { items: rows });
		expect(parse(r.content)).toMatchObject({
			instagram: "https://instagram.com/bluebottle_syd",
			facebook: "https://facebook.com/BlueBottleNewtown",
			email: "hello@bluebottle.example",
			precision: "best-effort",
		});
	});

	it("accepts the web_search {results:[…]} envelope directly", async () => {
		const searchOutput = {
			query: "cafe newtown instagram",
			count: 1,
			results: [{ title: "x", link: "https://instagram.com/some_cafe", snippet: "mailto:owner@cafe.test" }],
		};
		const r = await extractT.handler(baseCtx, { items: searchOutput });
		const out = parse(r.content);
		expect(out.instagram).toBe("https://instagram.com/some_cafe");
		expect(out.email).toBe("owner@cafe.test"); // mailto: preferred
	});

	it("ignores non-profile IG paths and share/login FB paths", async () => {
		const rows = [
			{ link: "https://www.instagram.com/p/ABC123/", snippet: "a post, not a profile" },
			{ link: "https://www.facebook.com/sharer/sharer.php?u=x", snippet: "a share link" },
			{ link: "https://instagram.com/realbiz", snippet: "the actual profile" },
		];
		const out = parse((await extractT.handler(baseCtx, { items: rows })).content);
		expect(out.instagram).toBe("https://instagram.com/realbiz");
		expect(out.facebook).toBeNull(); // only a share link was present
	});

	it("missing fields → null (best-effort, no false positives)", async () => {
		const out = parse((await extractT.handler(baseCtx, { items: [{ title: "no socials here", link: "https://example.com", snippet: "nothing" }] })).content);
		expect(out).toMatchObject({ instagram: null, facebook: null, email: null });
	});

	it("honors the `fields` subset", async () => {
		const rows = [{ link: "https://instagram.com/biz", snippet: "hi@biz.test facebook.com/biz" }];
		const out = parse((await extractT.handler(baseCtx, { items: rows, fields: ["email"] })).content);
		expect(out.email).toBe("hi@biz.test");
		expect(out.instagram).toBeNull();
		expect(out.facebook).toBeNull();
	});
});

// ── composition proof: the lead-finder end-to-end from the catalog ────────────────
describe("lead-finder expressible from the catalog (issue #94 acceptance)", () => {
	it("map → filter → dedupe_upsert compose via runRegistryTool", async () => {
		// map: extract site + reachable passthrough; filter: no-site OR unreachable;
		// dedupe_upsert: by place_id → leads. All dispatched through runRegistryTool (the
		// path the #97 runner uses).
		const raw = [
			{ place_id: "a", websiteUri: "https://a.test", reachable: true }, // drop (healthy)
			{ place_id: "b", websiteUri: null, reachable: null }, // keep (no site)
			{ place_id: "c", websiteUri: "https://c.test", reachable: false }, // keep (dead)
		];
		const mapped = JSON.parse((await runRegistryTool("map", baseCtx, {
			items: raw,
			keep: ["place_id", "websiteUri", "reachable"],
		})).content).items;
		const filtered = JSON.parse((await runRegistryTool("filter", baseCtx, {
			items: mapped, any: true,
			where: [{ field: "websiteUri", op: "missing" }, { field: "reachable", op: "eq", value: false }],
		})).content).items;
		expect(filtered.map((x: any) => x.place_id)).toEqual(["b", "c"]);

		const { env, calls } = mockAgentStub({});
		const stored = JSON.parse((await runRegistryTool("dedupe_upsert", { env, instanceId: "inst1" } as RegistryToolCtx, {
			items: filtered, collection: "leads", key: "place_id",
		})).content);
		expect(stored.inserted).toBe(2);
		expect(calls.filter((c) => c.method === "POST").length).toBe(2);
	});
});
