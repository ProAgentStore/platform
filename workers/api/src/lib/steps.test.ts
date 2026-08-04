import { afterEach, describe, expect, it, vi } from "vitest";
import { getRegistryTool, runRegistryTool } from "./tool-registry.js";
import { differsFrom } from "./steps.js";
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
function mockAgentStub(seen: Record<string, string>, stored: Record<string, Record<string, unknown>> = {}) {
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
			// The real route answers full CollectionRecords (id + data) — `emitOn:"update"` has
			// to compare against that data to know whether anything actually changed.
			return new Response(JSON.stringify({ records: id ? [{ id, data: stored[kv] }] : [], total: id ? 1 : 0 }), { status: 200 });
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

// ── slice + parse_json + $format: the composition primitives the site-builder needed ────
const sliceT = getRegistryTool("slice")!;
const parseJsonT = getRegistryTool("parse_json")!;

describe("slice", () => {
	const items = [1, 2, 3, 4, 5].map((n) => ({ n }));

	it("takes the first `limit` records and reports what it dropped", async () => {
		const r = parse((await sliceT.handler(baseCtx, { items, limit: 2 })).content);
		expect(r.items.map((i: { n: number }) => i.n)).toEqual([1, 2]);
		expect(r).toMatchObject({ count: 2, dropped: 3 });
	});

	it("skips `offset` first", async () => {
		const r = parse((await sliceT.handler(baseCtx, { items, offset: 3, limit: 10 })).content);
		expect(r.items.map((i: { n: number }) => i.n)).toEqual([4, 5]);
	});

	it("passes everything through when no limit is given", async () => {
		expect(parse((await sliceT.handler(baseCtx, { items })).content).count).toBe(5);
	});

	it("handles a shorter list, an empty list, and limit 0 without erroring", async () => {
		expect(parse((await sliceT.handler(baseCtx, { items, limit: 99 })).content).count).toBe(5);
		expect(parse((await sliceT.handler(baseCtx, { items: [], limit: 3 })).content).count).toBe(0);
		expect(parse((await sliceT.handler(baseCtx, { items, limit: 0 })).content).count).toBe(0);
	});
});

describe("parse_json", () => {
	it("parses a clean JSON string into structured fields", async () => {
		const r = parse((await parseJsonT.handler(baseCtx, { items: [{ text: '{"a":1}' }] })).content);
		expect(r.items[0].text).toEqual({ a: 1 });
		expect(r.failed).toBe(0);
	});

	it("strips the ```json fence models add", async () => {
		const items = [{ out: '```json\n{"a":1}\n```' }];
		const r = parse((await parseJsonT.handler(baseCtx, { items, field: "out", as: "parsed" })).content);
		expect(r.items[0].parsed).toEqual({ a: 1 });
		expect(r.items[0].out).toBe('```json\n{"a":1}\n```'); // the raw reply is kept
	});

	it("digs the JSON out of surrounding prose", async () => {
		const items = [{ text: 'Sure! Here you go:\n{"a":[1,2]}\nHope that helps.' }];
		expect(parse((await parseJsonT.handler(baseCtx, { items })).content).items[0].text).toEqual({ a: [1, 2] });
	});

	it("writes null and counts a failure instead of failing the batch", async () => {
		const items = [{ text: "not json at all" }, { text: '{"ok":true}' }];
		const r = parse((await parseJsonT.handler(baseCtx, { items })).content);
		expect(r.items[0].text).toBeNull();
		expect(r.items[1].text).toEqual({ ok: true });
		expect(r).toMatchObject({ count: 2, failed: 1 });
	});

	it("passes an already-parsed value through", async () => {
		const r = parse((await parseJsonT.handler(baseCtx, { items: [{ text: { a: 1 } }] })).content);
		expect(r.items[0].text).toEqual({ a: 1 });
	});
});

describe("map derive — $format (compose a string from other fields)", () => {
	it("renders {{field}} from the record", async () => {
		const items = [{ name: "Palm Tree Kiosk", suburb: "Bondi" }];
		const r = parse((await mapT.handler(baseCtx, { items, derive: { q: { $format: "{{name}} {{suburb}} instagram" } } })).content);
		expect(r.items[0].q).toBe("Palm Tree Kiosk Bondi instagram");
	});

	it("sees fields that `extract` just produced — derive runs last, over the reshaped record", async () => {
		// The bug this closes: $format could only reference RAW input fields, so composing
		// from a flattened API response (the normal case) silently produced a blank string.
		const items = [{ d: { displayName: { text: "Palm Tree Kiosk" } } }];
		const r = parse(
			(await mapT.handler(baseCtx, {
				items,
				extract: { name: "d.displayName.text" },
				keep: [],
				derive: { title: { $format: "Deploy the site for {{name}}" } },
			})).content,
		);
		expect(r.items[0].title).toBe("Deploy the site for Palm Tree Kiosk");
	});

	it("collapses the gap a missing field leaves behind", async () => {
		const items = [{ name: "Joe's" }]; // no suburb
		const r = parse((await mapT.handler(baseCtx, { items, derive: { q: { $format: "{{name}} {{suburb}} cafe" } } })).content);
		expect(r.items[0].q).toBe("Joe's cafe");
	});

	it("still treats a plain object as a literal", async () => {
		const r = parse((await mapT.handler(baseCtx, { items: [{ a: 1 }], derive: { meta: { kind: "x" } } })).content);
		expect(r.items[0].meta).toEqual({ kind: "x" });
	});
});

describe("dedupe_upsert — emitOn (what makes an agent CHAIN possible)", () => {
	/** Capture what the pump was handed, without touching the real connections module. */
	async function emitFor(input: Record<string, unknown>, existing: Record<string, string> = {}) {
		const { env } = mockAgentStub(existing);
		const delivered: Array<{ event: string; payloads: unknown[] }> = [];
		vi.doMock("./connections.js", () => ({
			deliverEvent: async (_e: unknown, _i: string, _u: string, event: string, payloads: unknown[]) => {
				delivered.push({ event, payloads });
				return { connections: 1, delivered: payloads.length, failed: 0 };
			},
		}));
		const ctx = { env, instanceId: "inst1", userId: "u1" } as RegistryToolCtx;
		const r = await dedupeT.handler(ctx, input);
		vi.doUnmock("./connections.js");
		return { res: parse(r.content), delivered };
	}

	const ITEMS = [{ place_id: "p_new", name: "New" }, { place_id: "p_old", name: "Existing" }];

	it("defaults to insert-only — the lead-finder's behaviour is unchanged", async () => {
		const { res, delivered } = await emitFor({ collection: "leads", key: "place_id", items: ITEMS, emit: "lead.created" }, { p_old: "existing" });
		expect(res).toMatchObject({ inserted: 1, updated: 1 });
		expect(delivered[0].event).toBe("lead.created");
		expect(delivered[0].payloads).toEqual([{ place_id: "p_new", name: "New" }]);
	});

	it('emitOn:"update" announces a STATE CHANGE on a record that already exists', async () => {
		// The chain case: the second agent writes to a record the first one created, so
		// insert-only emit could never signal it (a site going drafted → live).
		const { delivered } = await emitFor(
			{ collection: "sites", key: "place_id", items: [{ place_id: "p_old", site_status: "live" }], emit: "site.live", emitOn: "update" },
			{ p_old: "existing" },
		);
		expect(delivered[0].payloads).toEqual([{ place_id: "p_old", site_status: "live" }]);
	});

	it('emitOn:"update" stays silent when nothing actually changed', async () => {
		const { delivered } = await emitFor({ collection: "sites", key: "place_id", items: [{ place_id: "p_new" }], emit: "site.live", emitOn: "update" });
		expect(delivered).toHaveLength(0); // it was an INSERT, not an update
	});

	it('emitOn:"both" covers either transition', async () => {
		const { delivered } = await emitFor(
			{ collection: "sites", key: "place_id", items: ITEMS, emit: "site.live", emitOn: "both" },
			{ p_old: "existing" },
		);
		expect(delivered[0].payloads).toHaveLength(2);
	});

	it("an unknown emitOn falls back to insert rather than emitting everything", async () => {
		const { delivered } = await emitFor(
			{ collection: "sites", key: "place_id", items: ITEMS, emit: "x", emitOn: "whenever" },
			{ p_old: "existing" },
		);
		expect(delivered[0].payloads).toHaveLength(1);
	});

	it("emits nothing at all when no event is declared", async () => {
		const { delivered } = await emitFor({ collection: "leads", key: "place_id", items: ITEMS, emitOn: "both" }, { p_old: "existing" });
		expect(delivered).toHaveLength(0);
	});
});

describe("dedupe_upsert emitOn:\"update\" — a re-write is not a CHANGE", () => {
	// `changedRows` decides what emitOn:"update"/"both" emits, and it used to be pushed on every
	// successful PUT — i.e. "every record that already existed", not "every record that changed".
	// site-deploy uses `mode:"update", emit:"site.live", emitOn:"both"`, so re-running it for an
	// unchanged place_id (a re-approved ticket — `failed` is runnable — or a scheduled re-run)
	// re-emitted `site.live`. The idempotency key cannot collapse it, because a new run has a new
	// traceId. The wired Outreach instance then drafted, and billed for, a second pitch for a site
	// that had not changed. `differsFrom` is that decision.
	const item = { place_id: "p1", name: "Cafe", site_status: "live" };

	it("says NO CHANGE for a byte-identical record", () => {
		expect(differsFrom({ ...item }, item)).toBe(false);
	});

	it("says CHANGED for the state transition the chain is built on", () => {
		expect(differsFrom({ ...item, site_status: "drafted" }, item)).toBe(true);
	});

	it("says NO CHANGE for a field OUTSIDE the collection schema — it is not persisted", () => {
		// `validateRecord` keeps only schema fields, so writing a non-schema key changes nothing.
		// Reporting it as a change re-emitted `site.live` for a byte-identical record on every
		// run — and a new run has a new traceId, so the idempotency key cannot collapse it —
		// billing Outreach for a second pitch each time.
		const schema = new Set(["place_id", "name"]);
		expect(differsFrom({ place_id: "p1", name: "Cafe" }, item, schema)).toBe(false);
	});

	it("but says CHANGED for a schema field the stored record has not filled in yet", () => {
		// The inverse, and the one an earlier fix got wrong: `inferCollectionFields` maps EVERY key
		// of the first record including null-valued ones, while `validateRecord` drops the null
		// VALUE — so a key can be in the schema and absent from the record, and writing a real
		// value there IS persisted. Skipping it silently dropped the chain link for any pipeline
		// whose state change is "fill in a field that was null".
		const schema = new Set(["place_id", "name", "site_status"]);
		expect(differsFrom({ place_id: "p1", name: "Cafe" }, item, schema)).toBe(true);
	});

	it("with NO schema, errs toward CHANGED — a missed emit is silent, a duplicate is visible", () => {
		expect(differsFrom({ place_id: "p1", name: "Cafe" }, item)).toBe(true);
		// ...but an empty incoming value would be dropped on write too, so it is still no change.
		expect(differsFrom({ place_id: "p1" }, { place_id: "p1", email: null })).toBe(false);
		expect(differsFrom({ place_id: "p1" }, { place_id: "p1", email: "" })).toBe(false);
	});

	it("but says CHANGED when NOTHING is comparable — we cannot show it is unchanged", () => {
		expect(differsFrom({ unrelated: 1 }, item)).toBe(true);
	});

	it("ignores the type coercion validateRecord applies on write", () => {
		// A `string` field stores String(value); that is not a state change.
		expect(differsFrom({ rating: "4" }, { rating: 4 })).toBe(false);
		expect(differsFrom({ rating: "4" }, { rating: 5 })).toBe(true);
	});

	it("says CHANGED when there is no stored record to compare against", () => {
		expect(differsFrom(undefined, item)).toBe(true);
	});

	it("ignores stored fields the pipeline does not write — the audit trail is not a change", () => {
		expect(differsFrom({ ...item, audit: [{ step: 1 }], other_pipeline_col: 7 }, item)).toBe(false);
	});

	it("compares nested values structurally, not by reference", () => {
		expect(differsFrom({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toBe(false);
		expect(differsFrom({ a: { b: [1, 2] } }, { a: { b: [1, 3] } })).toBe(true);
	});

	it("treats undefined and null as the same absence", () => {
		// A record round-tripped through JSON loses `undefined`; that is not a state change.
		expect(differsFrom({ x: null }, { x: undefined } as Record<string, unknown>)).toBe(false);
	});

	it("still upserts the record either way — this only decides whether to ANNOUNCE it", async () => {
		const { env, calls } = mockAgentStub({ p1: "existing" }, { p1: { ...item } });
		const ctx = { env, instanceId: "inst1", userId: "u1" } as RegistryToolCtx;
		const r = await dedupeT.handler(ctx, {
			collection: "sites", key: "place_id", mode: "update", emit: "site.live", emitOn: "update", items: [item],
		});
		expect(parse(r.content)).toMatchObject({ updated: 1 });
		expect(calls.some((c) => c.method === "PUT")).toBe(true);
	});
});

describe("enrich — a step whose every call failed is not a successful step", () => {
	it("FAILS when every per-item tool call failed, instead of writing the error text as data", async () => {
		// With no vault key, `web_search` returns success:false and a prose message. enrich ignored
		// `success` entirely: it wrote "No API key connected for the web-search connector…" onto
		// every record under `as`, returned success, and the run closed "completed" with errors: 0
		// — prose in the collection where structured data belonged, and nothing to find.
		const r = await enrichT.handler(baseCtx, {
			items: [{ id: 1 }, { id: 2 }],
			tool: "definitely_not_a_tool",
			as: "result",
		});
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/all 2 .*call\(s\) failed/i);
	});

	it("reports a PARTIAL failure count while still returning the good records", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (u: any) => {
			if (String(u).includes("live")) return new Response("hi", { status: 200 });
			throw new Error("ECONNREFUSED");
		});
		const r = await enrichT.handler(baseCtx, {
			items: [{ websiteUri: "https://live.test" }, { websiteUri: "https://dead.test" }],
			tool: "http_reachable",
			input: { url: { $item: "websiteUri" } },
			as: "reachable",
		});
		// http_reachable reports a dead host as ok:false but the CALL succeeds — a partial
		// business-level result is not a step failure.
		expect(r.success).toBe(true);
		expect(parse(r.content).count).toBe(2);
	});
});
