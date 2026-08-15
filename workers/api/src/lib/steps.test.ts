import { afterEach, describe, expect, it, vi } from "vitest";
import { getRegistryTool, runRegistryTool } from "./tool-registry.js";
import { differsFrom } from "./steps.js";
import type { RegistryToolCtx } from "./tool-registry.js";

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

/**
 * Knowingly-partial test doubles, and the ONLY `any` left in this file.
 *
 * A step tool takes a full `RegistryToolCtx` — a whole `Env` of bindings, a `ConnectorClient`
 * with four methods — and the tools under test touch almost none of it. Declaring an interface
 * for the subset each one happens to use would put a second, unmaintained shape in front of the
 * compiler and have it vouch for that; `as unknown as X` is the same claim with the lint rule
 * switched off. So the cast stays, deliberately, and stays HERE: one place that says it is a
 * fake, instead of fifteen call sites that quietly imply they are not.
 */
// biome-ignore lint/suspicious/noExplicitAny: deliberate partial double — see the block above.
const fakeEnv = (bindings: Record<string, unknown> = {}): any => bindings;
// biome-ignore lint/suspicious/noExplicitAny: deliberate partial double — see the block above.
const fakeConnectorClient = (impl: unknown = {}): any => (typeof impl === "function" ? impl : () => impl);

const baseCtx = { env: fakeEnv() } as RegistryToolCtx;

/** A tool's JSON reply. Fields are `unknown` — the `expect` below is the check. */
function parse(content: string): Record<string, unknown> {
	return JSON.parse(content) as Record<string, unknown>;
}
/** One field narrowed to a list of records, so `.map`/`.find` need no `any`. */
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : []);

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
		const out = rows(parse(r.content).items)[0];
		expect(out).toEqual({ place_id: "p1", city: "Sydney", suburb: "Newtown", state: "NSW", country: "Australia" });
	});

	it("renames fields, derives constants, builds nested output paths", async () => {
		const r = await mapT.handler(baseCtx, {
			items: [{ displayName: { text: "Cafe" }, websiteUri: "https://x.test" }],
			rename: { "displayName.text": "name", websiteUri: "geo.site" },
			derive: { source: "places" },
		});
		const out = rows(parse(r.content).items)[0];
		expect(out.name).toBe("Cafe");
		expect(out.geo).toEqual({ site: "https://x.test" });
		expect(out.source).toBe("places");
	});

	it("missing nested path → null, and treats a single object as one item", async () => {
		const r = await mapT.handler(baseCtx, { items: { a: 1 }, extract: { b: "nope.deep" } });
		const parsed = parse(r.content);
		expect(parsed.count).toBe(1);
		expect(rows(parsed.items)[0].b).toBeNull();
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
		const kept = rows(parse(r.content).items).map((x) => x.id);
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
		expect(rows(parsed.items).map((x) => x.place_id)).toEqual(["a", "b", "c"]);
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
		expect(rows(parse(r.content).items).map((x) => x.place_id)).toEqual(["a", "b", "c"]);
	});

	// ── #243, milder sibling of slice.limit ───────────────────────────────────
	// `Number(depth) || 0` turned an unreadable depth into 0, so the flatten silently did
	// NOTHING and passed the array-of-arrays it exists to collapse straight to the next step —
	// which then mapped/filtered over arrays instead of records, successfully.
	it("FAILS on an unreadable depth instead of silently no-opping the flatten", async () => {
		for (const depth of ["", "deep", false]) {
			const r = await flattenT.handler(baseCtx, { items: [[1], [2]], depth });
			expect(r.success, `depth ${JSON.stringify(depth)} must not be treated as 0`).toBe(false);
			expect(r.content).toContain('"depth"');
		}
	});

	it("keeps the documented default of 1 when depth is absent, and honours an explicit 0", async () => {
		expect(parse((await flattenT.handler(baseCtx, { items: [[1], [2]] })).content).items).toEqual([1, 2]);
		expect(parse((await flattenT.handler(baseCtx, { items: [[1], [2]], depth: 0 })).content).items).toEqual([[1], [2]]);
		expect(parse((await flattenT.handler(baseCtx, { items: [[[1]]], depth: "2" })).content).items).toEqual([1]);
	});
});

// ── 3. dedupe_upsert ─────────────────────────────────────────────────────────────
// Mock the instance DO: GET records?where= returns a seen map keyed by place_id; POST
// inserts; PUT updates. Proves insert-vs-update routing + that we never double-insert a
// key that already exists (respecting the collection's unique constraint).
function mockAgentStub(
	seen: Record<string, string>,
	stored: Record<string, Record<string, unknown>> = {},
	/** #630: make the DO REFUSE writes — the shape a full collection or a unique-constraint race
	 *  has in production, and the one the old code counted as `skipped`. `failKeys` refuses only
	 *  those records, so a PARTIAL failure can be told apart from a total one. */
	writes: { status?: number; error?: string; failKeys?: string[] } = {},
) {
	const calls: Array<{ method: string; url: string; body?: unknown }> = [];
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
		const refused = (() => {
			if (!writes.status && !writes.error) return false;
			if (!writes.failKeys) return true;
			const data = (body as { data?: Record<string, unknown> } | undefined)?.data ?? {};
			return writes.failKeys.includes(String(data.place_id ?? ""));
		})();
		if (refused && (method === "POST" || method === "PUT")) {
			// What the AgentDO actually answers with — `{error: message}` and a 500 (agent-do.ts).
			return new Response(JSON.stringify({ error: writes.error ?? "boom" }), { status: writes.status ?? 500 });
		}
		if (method === "POST") return new Response(JSON.stringify({ id: "new1" }), { status: 201 });
		if (method === "PUT") return new Response(JSON.stringify({ id: "existing" }), { status: 200 });
		return new Response("no", { status: 404 });
	});
	const env = fakeEnv({ AGENT: { idFromName: (n: string) => n, get: () => ({ fetch }) } });
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

/**
 * #630 — a write that FAILED used to increment `skipped`, the same counter as "this item had no
 * key" and "mode:skip, already seen". The run then closed `completed` with `errors: 0`, so a sweep
 * that stored nothing was indistinguishable from one that correctly changed nothing.
 *
 * The trigger is dated rather than hypothetical: `MAX_COLLECTION_RECORDS` is 10,000 and enforced by
 * a throw, so on the run that crosses it — and every run after it, forever — the old code reported
 * success and stored nothing, and emitted nothing, so the chain stopped with no dead letter to find
 * (a delivery that is never enqueued has no row to replay).
 */
describe("dedupe_upsert — a failed write is not a skip (#630)", () => {
	const FULL = 'Collection "leads" is full (max 10000 records)';

	it("counts a refused write as `failed`, and carries the reason the DO gave", async () => {
		const { env } = mockAgentStub({}, {}, { error: FULL, failKeys: ["p2"] });
		const r = await dedupeT.handler({ env, instanceId: "inst1" } as RegistryToolCtx, {
			collection: "leads",
			key: "place_id",
			items: [{ place_id: "p1" }, { place_id: "p2" }],
		});
		const res = parse(r.content);
		expect(res).toMatchObject({ inserted: 1, failed: 1, skipped: 0 });
		// The body carried this all along and `res.ok` was the only thing read.
		expect(res.firstError).toBe(FULL);
	});

	it("keeps `skipped` for the two DELIBERATE cases only", async () => {
		const { env } = mockAgentStub({ p1: "existing" });
		const r = await dedupeT.handler({ env, instanceId: "inst1" } as RegistryToolCtx, {
			collection: "leads",
			key: "place_id",
			mode: "skip",
			items: [{ place_id: "p1" }, { name: "no key" }],
		});
		expect(parse(r.content)).toMatchObject({ skipped: 2, failed: 0 });
	});

	it("FAILS the step when every attempted write failed — the sweep stored nothing", async () => {
		// The rule `enrich` already applies to the same shape: all-failed means the target is
		// broken, not that the data was odd. Without it the run closes `completed` over a full
		// collection, which is the sharpest form of this whole class.
		const { env } = mockAgentStub({}, {}, { error: FULL });
		const r = await dedupeT.handler({ env, instanceId: "inst1" } as RegistryToolCtx, {
			collection: "leads",
			key: "place_id",
			items: [{ place_id: "p1" }, { place_id: "p2" }],
		});
		expect(r.success).toBe(false);
		expect(r.content).toContain("all 2 write(s)");
		expect(r.content).toContain(FULL);
	});

	it("a partial failure still succeeds — the records that landed are real", async () => {
		const { env } = mockAgentStub({}, {}, { error: FULL, failKeys: ["p2"] });
		const r = await dedupeT.handler({ env, instanceId: "inst1" } as RegistryToolCtx, {
			collection: "leads",
			key: "place_id",
			items: [{ place_id: "p1" }, { place_id: "p2" }],
		});
		expect(r.success).toBe(true);
	});

	it("does not emit for a record whose write failed", async () => {
		// `payloads` is built from the rows that came back ok, which was already true — pinned here
		// because a chain firing on a record that was never stored is the worse bug of the two.
		const { env } = mockAgentStub({}, {}, { error: FULL, failKeys: ["p2"] });
		const delivered: unknown[][] = [];
		vi.doMock("./connections.js", () => ({
			deliverEvent: async (_e: unknown, _i: string, _u: string, _ev: string, payloads: unknown[]) => {
				delivered.push(payloads);
				return { connections: 1, delivered: payloads.length, failed: 0, queued: payloads.length, filtered: 0, duplicate: 0, disabled: 0 };
			},
		}));
		await dedupeT.handler({ env, instanceId: "inst1", userId: "u1" } as RegistryToolCtx, {
			collection: "leads",
			key: "place_id",
			emit: "lead.created",
			items: [{ place_id: "p1" }, { place_id: "p2" }],
		});
		vi.doUnmock("./connections.js");
		expect(delivered[0]).toEqual([{ place_id: "p1" }]);
	});

	it("keeps the pump's other counters instead of reading only `delivered`", async () => {
		// filtered/duplicate/disabled are the three numbers that answer "why did my chain not
		// fire?", and `queued` is why a retrying delivery must not read as "not emitted".
		const { env } = mockAgentStub({});
		vi.doMock("./connections.js", () => ({
			deliverEvent: async () => ({ connections: 3, delivered: 0, failed: 1, queued: 1, filtered: 1, duplicate: 1, disabled: 1 }),
		}));
		const r = await dedupeT.handler({ env, instanceId: "inst1", userId: "u1" } as RegistryToolCtx, {
			collection: "leads",
			key: "place_id",
			emit: "lead.created",
			items: [{ place_id: "p1" }],
		});
		vi.doUnmock("./connections.js");
		expect(parse(r.content).delivery).toEqual({ connections: 3, delivered: 0, queued: 1, retrying: 1, filtered: 1, duplicate: 1, disabled: 1 });
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
		vi.spyOn(globalThis, "fetch").mockImplementation(async (u: RequestInfo | URL) => {
			const url = new URL(String(u));
			const token = url.searchParams.get("pageToken") || "";
			seenTokens.push(token);
			const page = token === "" ? { items: [{ id: 1 }, { id: 2 }], next: "T2" }
				: token === "T2" ? { items: [{ id: 3 }], next: null }
					: { items: [], next: null };
			return new Response(JSON.stringify(page), { status: 200, headers: { "Content-Type": "application/json" } });
		});
		const ctx = {
			env: fakeEnv(),
			connectorClient: fakeConnectorClient(),
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
		const ctx = { env: fakeEnv(), connectorClient: fakeConnectorClient() } as RegistryToolCtx;
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
		expect(rows(parsed.items)[0].id).toBe(1);
		expect(rows(parsed.items)[0].tag).toMatchObject({ count: 1 });
	});

	it("the reachability enrich-merge (the lead-finder 'is this site up' half)", async () => {
		// enrich with http_reachable; {$item:"websiteUri"} feeds each item's url. Mock the wire:
		// one live site, one dead host.
		vi.spyOn(globalThis, "fetch").mockImplementation(async (u: RequestInfo | URL) => {
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
		const items = rows(parse(r.content).items);
		// each place now carries {ok,code} under `reachable` — correlated to ITS url.
		expect(items.find((x) => x.place_id === "a")!.reachable).toMatchObject({ ok: true, code: 200 });
		expect(items.find((x) => x.place_id === "b")!.reachable).toMatchObject({ ok: false, code: null });
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
		expect(rows(parse(r.content).items).map((x) => x.place_id)).toEqual(["a", "b"]);
	});

	it("fails without tool/as", async () => {
		expect((await enrichT.handler(baseCtx, { items: [{ a: 1 }], as: "x" })).success).toBe(false);
		expect((await enrichT.handler(baseCtx, { items: [{ a: 1 }], tool: "map" })).success).toBe(false);
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
		vi.spyOn(globalThis, "fetch").mockImplementation(async (u: RequestInfo | URL, init?: RequestInit) => {
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
			env: fakeEnv(),
			instanceId: "inst1",
			connectorClient: fakeConnectorClient((provider: string) => ({
				connector: { id: provider },
				token: async () => "VAULT_KEY",
				requireGrant: async () => ({}),
				fetch: async () => new Response(""),
			})),
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
			env: fakeEnv(), instanceId: "inst1",
			connectorClient: fakeConnectorClient({ token: async () => "K" }),
		} as RegistryToolCtx;
		const r = await geocodeT.handler(ctx, { address: "Nowhereville" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/no geocode result/i);
	});

	it("rejects an unsupported provider", async () => {
		const ctx = { env: fakeEnv(), connectorClient: fakeConnectorClient() } as RegistryToolCtx;
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
		expect(rows(filtered).map((x) => x.place_id)).toEqual(["b", "c"]);

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
		expect(rows(r.items).map((i) => i.n)).toEqual([1, 2]);
		expect(r).toMatchObject({ count: 2, dropped: 3 });
	});

	it("skips `offset` first", async () => {
		const r = parse((await sliceT.handler(baseCtx, { items, offset: 3, limit: 10 })).content);
		expect(rows(r.items).map((i) => i.n)).toEqual([4, 5]);
	});

	it("passes everything through when no limit is given", async () => {
		expect(parse((await sliceT.handler(baseCtx, { items })).content).count).toBe(5);
	});

	it("handles a shorter list, an empty list, and limit 0 without erroring", async () => {
		expect(parse((await sliceT.handler(baseCtx, { items, limit: 99 })).content).count).toBe(5);
		expect(parse((await sliceT.handler(baseCtx, { items: [], limit: 3 })).content).count).toBe(0);
		expect(parse((await sliceT.handler(baseCtx, { items, limit: 0 })).content).count).toBe(0);
	});

	// ── #243 ──────────────────────────────────────────────────────────────────
	// `Number(x) || 0` mapped "", "abc" and false to 0, and 0 means KEEP NOTHING — while an
	// ABSENT limit keeps everything. So a blank `$param` (a settings or trigger field left
	// empty) emptied the list mid-chain, every downstream step succeeded over nothing, and the
	// run COMPLETED reporting "0 leads" — indistinguishable from "nothing matched". Nobody
	// debugs a successful run that found nothing.
	//
	// Each case below returned `{count: 0, success: true}` before the fix.
	it("FAILS on an unreadable limit instead of silently keeping zero records", async () => {
		for (const limit of ["", "  ", "fifty", false, [], {}]) {
			const r = await sliceT.handler(baseCtx, { items, limit });
			expect(r.success, `limit ${JSON.stringify(limit)} must not be treated as 0`).toBe(false);
			expect(r.content).toContain('"limit"');
		}
	});

	it("says what to do about it — the reference feeding the field is the actual fault", async () => {
		const r = await sliceT.handler(baseCtx, { items, limit: "" });
		expect(r.content).toContain("keep ZERO records");
		expect(r.content).toContain("leave it unset to keep all");
		expect(r.content).toContain("$param");
	});

	it("fails on an unreadable offset too, rather than quietly starting from the top", async () => {
		const r = await sliceT.handler(baseCtx, { items, offset: "abc", limit: 2 });
		expect(r.success).toBe(false);
		expect(r.content).toContain('"offset"');
	});

	it("still accepts every legitimate way to say a number", async () => {
		// A numeric string is the normal shape of a $param off a settings field.
		expect(parse((await sliceT.handler(baseCtx, { items, limit: "2" })).content).count).toBe(2);
		expect(rows(parse((await sliceT.handler(baseCtx, { items, limit: 2, offset: "1" })).content).items)[0].n).toBe(2);
		// An explicit 0 is a real request for zero records and must keep working.
		expect((await sliceT.handler(baseCtx, { items, limit: 0 })).success).toBe(true);
		// Absent means "all" — a blank param must NOT reach this branch, which is the bug.
		expect(parse((await sliceT.handler(baseCtx, { items, limit: null })).content).count).toBe(5);
	});
});

describe("parse_json", () => {
	it("parses a clean JSON string into structured fields", async () => {
		const r = parse((await parseJsonT.handler(baseCtx, { items: [{ text: '{"a":1}' }] })).content);
		expect(rows(r.items)[0].text).toEqual({ a: 1 });
		expect(r.failed).toBe(0);
	});

	it("strips the ```json fence models add", async () => {
		const items = [{ out: '```json\n{"a":1}\n```' }];
		const r = parse((await parseJsonT.handler(baseCtx, { items, field: "out", as: "parsed" })).content);
		expect(rows(r.items)[0].parsed).toEqual({ a: 1 });
		expect(rows(r.items)[0].out).toBe('```json\n{"a":1}\n```'); // the raw reply is kept
	});

	it("digs the JSON out of surrounding prose", async () => {
		const items = [{ text: 'Sure! Here you go:\n{"a":[1,2]}\nHope that helps.' }];
		expect(rows(parse((await parseJsonT.handler(baseCtx, { items })).content).items)[0].text).toEqual({ a: [1, 2] });
	});

	it("writes null and counts a failure instead of failing the batch", async () => {
		const items = [{ text: "not json at all" }, { text: '{"ok":true}' }];
		const r = parse((await parseJsonT.handler(baseCtx, { items })).content);
		expect(rows(r.items)[0].text).toBeNull();
		expect(rows(r.items)[1].text).toEqual({ ok: true });
		expect(r).toMatchObject({ count: 2, failed: 1 });
	});

	it("passes an already-parsed value through", async () => {
		const r = parse((await parseJsonT.handler(baseCtx, { items: [{ text: { a: 1 } }] })).content);
		expect(rows(r.items)[0].text).toEqual({ a: 1 });
	});
});

describe("map derive — $format (compose a string from other fields)", () => {
	it("renders {{field}} from the record", async () => {
		const items = [{ name: "Palm Tree Kiosk", suburb: "Bondi" }];
		const r = parse((await mapT.handler(baseCtx, { items, derive: { q: { $format: "{{name}} {{suburb}} instagram" } } })).content);
		expect(rows(r.items)[0].q).toBe("Palm Tree Kiosk Bondi instagram");
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
		expect(rows(r.items)[0].title).toBe("Deploy the site for Palm Tree Kiosk");
	});

	it("collapses the gap a missing field leaves behind", async () => {
		const items = [{ name: "Joe's" }]; // no suburb
		const r = parse((await mapT.handler(baseCtx, { items, derive: { q: { $format: "{{name}} {{suburb}} cafe" } } })).content);
		expect(rows(r.items)[0].q).toBe("Joe's cafe");
	});

	it("still treats a plain object as a literal", async () => {
		const r = parse((await mapT.handler(baseCtx, { items: [{ a: 1 }], derive: { meta: { kind: "x" } } })).content);
		expect(rows(r.items)[0].meta).toEqual({ kind: "x" });
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
		vi.spyOn(globalThis, "fetch").mockImplementation(async (u: RequestInfo | URL) => {
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
