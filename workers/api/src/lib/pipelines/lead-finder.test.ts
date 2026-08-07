// CAPSTONE PROOF (epic #94): the lead-finder as a PURE DECLARATIVE PIPELINE — the JSON in
// lead-finder.json is data, not code — driven end-to-end through the REAL runner
// (executePipelineStep) and the REAL step handlers (fan_out/flatten/map/enrich/filter from
// steps.ts). Only the two true I/O boundaries are mocked: the outbound HTTP (geocode +
// per-cell Places searchNearby + reachability) and the collection sink (dedupe_upsert's
// Durable Object). Everything between them — input resolution ($ref/$param, incl. the #114
// dotted-item + #116 type-predicate + #113 flatten + #115 enrich-merge primitives), step
// threading (bind/forEach), the grid fan-out, the map reshape, the no-website-OR-unreachable
// filter, and the per-record audit trail — is exercised for real.
//
// This is the FULL SWEEP (not the earlier "spine only"): the four gaps the #94 capstone first
// hit (#113–#116) are now CLOSED, so the tests that used to assert-the-limitation now assert-
// it-works. The green test hides nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import leadFinder from "./lead-finder.json" with { type: "json" };

// The REAL pure step handlers — we route the transform steps to these so the logic is
// genuinely tested, not faked.
import { STEP_TOOLS } from "../steps.js";
import { getPath } from "../connectors/http.js";

// Mock the tool-registry boundary the runner (and the enrich step) dispatch through.
// getRegistryTool must know every tool the JSON names (so validatePipeline passes);
// runRegistryTool routes pure tools to their real handlers and stubs the I/O tools.
const KNOWN = new Set(["geocode", "fan_out", "http_request", "flatten", "map", "enrich", "filter", "dedupe_upsert", "http_reachable"]);

// Captured sink writes so we can assert what landed in the `leads` collection.
let upserted: Array<Record<string, unknown>> = [];

const realHandler = (name: string) => STEP_TOOLS.find((t) => t.name === name)!.handler;

// A realistic Google Places searchNearby response — three cafes near Newtown, WITH real
// addressComponents arrays (typed-component shape). Their location matches specific grid
// cells so the per-cell mock returns them cell-by-cell (and the overlap proves dedupe).
//   • Corner Espresso — NO websiteUri            → qualifies (no website)
//   • Old Roasters    — websiteUri present, DEAD  → qualifies (unreachable)
//   • Bean Machine    — websiteUri present, LIVE  → NOT a lead
function addr(locality: string) {
	return [
		{ longText: locality, types: ["locality", "political"] },
		{ longText: "Marrickville", types: ["sublocality", "political"] },
		{ longText: "New South Wales", types: ["administrative_area_level_1", "political"] },
		{ longText: "Australia", types: ["country", "political"] },
	];
}

const BUSINESSES: Record<string, Array<Record<string, unknown>>> = {
	// keyed by a stable cell token (rounded lat,lng) → the raw Places `places` for that cell.
	cellA: [
		{
			id: "ChIJ_no_site",
			displayName: { text: "Corner Espresso" },
			formattedAddress: "1 King St, Newtown NSW 2042",
			nationalPhoneNumber: "0298001111",
			// NO websiteUri
			location: { latitude: -33.8951, longitude: 151.179 },
			googleMapsUri: "https://maps.google.com/?cid=1",
			addressComponents: addr("Newtown"),
		},
	],
	cellB: [
		{
			id: "ChIJ_dead_site",
			displayName: { text: "Old Roasters" },
			formattedAddress: "2 Enmore Rd, Newtown NSW 2042",
			nationalPhoneNumber: "0298002222",
			websiteUri: "https://oldroasters.example", // present but DEAD
			location: { latitude: -33.8972, longitude: 151.1766 },
			googleMapsUri: "https://maps.google.com/?cid=2",
			addressComponents: addr("Newtown"),
		},
		{
			id: "ChIJ_live_site",
			displayName: { text: "Bean Machine" },
			formattedAddress: "3 Australia St, Newtown NSW 2042",
			nationalPhoneNumber: "0298003333",
			websiteUri: "https://beanmachine.example", // LIVE
			location: { latitude: -33.8938, longitude: 151.1802 },
			googleMapsUri: "https://maps.google.com/?cid=3",
			addressComponents: addr("Newtown"),
		},
	],
	// cellDup re-returns the no-website business (grid cells overlap) → dedupe must collapse it.
	cellDup: [
		{
			id: "ChIJ_no_site",
			displayName: { text: "Corner Espresso" },
			formattedAddress: "1 King St, Newtown NSW 2042",
			nationalPhoneNumber: "0298001111",
			location: { latitude: -33.8951, longitude: 151.179 },
			googleMapsUri: "https://maps.google.com/?cid=1",
			addressComponents: addr("Newtown"),
		},
	],
};

// Which cell (by grid index) returns which businesses. Everything else returns an empty page.
// The grid in the JSON is extentKm 2 / stepKm 1 → 25 cells; we seed three of them.
let cellCounter = 0;
function placesForCell(_body: unknown): Array<Record<string, unknown>> {
	// The runner calls http_request once per cell in grid order; seed the first three cells.
	const idx = cellCounter++;
	if (idx === 0) return BUSINESSES.cellA;
	if (idx === 1) return BUSINESSES.cellB;
	if (idx === 2) return BUSINESSES.cellDup;
	return [];
}

const runRegistryTool = vi.fn(async (name: string, ctx: unknown, input: Record<string, unknown>) => {
	// ── real pure / step transforms ────────────────────────────────────────
	if (name === "map" || name === "filter" || name === "flatten" || name === "fan_out" || name === "enrich") {
		const r = await realHandler(name)(ctx as never, input);
		return { name, content: r.content, success: r.success };
	}
	// ── mocked I/O boundary ───────────────────────────────────────────────
	if (name === "geocode") {
		return { name, content: JSON.stringify({ lat: -33.8915, lng: 151.1795, country: "Australia", state: "New South Wales", locality: "Newtown", formatted: "Newtown NSW 2042, Australia" }), success: true };
	}
	if (name === "http_request") {
		// Per-cell Places searchNearby, AFTER the pipeline's responseMap projection. Each cell
		// returns its slice of businesses (as {status,data:[…]} — the http_request envelope).
		const projected = placesForCell(input.body).map((p) => ({
			place_id: p.id,
			name: (p.displayName as { text: string }).text,
			address: p.formattedAddress,
			phone: p.nationalPhoneNumber ?? null,
			websiteUri: p.websiteUri ?? null,
			lat: (p.location as { latitude: number }).latitude,
			lng: (p.location as { longitude: number }).longitude,
			maps_url: p.googleMapsUri,
			addressComponents: p.addressComponents, // raw Google typed-component array (#116)
		}));
		return { name, content: JSON.stringify({ status: 200, data: projected }), success: true };
	}
	if (name === "http_reachable") {
		const url = String(input.url ?? "");
		const alive = url === "https://beanmachine.example"; // only the live one is up
		return { name, content: JSON.stringify({ ok: alive, code: alive ? 200 : null }), success: true };
	}
	if (name === "dedupe_upsert") {
		const items = (Array.isArray(input.items) ? input.items : []) as Array<Record<string, unknown>>;
		const seen = new Set(upserted.map((r) => r[String(input.key)]));
		let inserted = 0;
		for (const it of items) {
			const k = it[String(input.key)];
			if (seen.has(k)) continue;
			seen.add(k);
			upserted.push(it);
			inserted++;
		}
		return { name, content: JSON.stringify({ inserted, updated: 0, skipped: items.length - inserted, total: items.length }), success: true };
	}
	return { name, content: `unexpected tool ${name}`, success: false };
});

vi.mock("../tool-registry.js", () => ({
	getRegistryTool: (name: string) => (KNOWN.has(name) ? { name } : undefined),
	runRegistryTool: (...args: unknown[]) => (runRegistryTool as unknown as (...a: unknown[]) => unknown)(...args),
}));

// Import AFTER the mock so pipeline.ts + steps.ts bind the mocked runRegistryTool.
import { attachAudit, auditStepEntry, executePipelineStep, stepBind, validatePipeline, resolveInputValue, type PipelineDef, type StepResult, type AuditEntry } from "../pipeline.js";
import type { Env } from "../../types.js";

/**
 * Readers for JSON that came back from a route, for use in assertions.
 *
 * Every field is `unknown`, not `any`. These response shapes are not declared types anywhere in
 * the worker, so an interface written here would be a second source of truth that nothing keeps
 * in step — and the compiler would then vouch for it. `unknown` leaves the `expect` below as the
 * only thing making a claim about the shape, which is what a test is for.
 */
const rec = (v: unknown): Record<string, unknown> => (v ?? {}) as Record<string, unknown>;
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : []);

const env = {} as Env;
const ctx = { env, userId: "u1", instanceId: "i1" };
const params = { city: "Newtown, NSW", type: "cafe", radius: 900 };

beforeEach(() => {
	runRegistryTool.mockClear();
	upserted = [];
	cellCounter = 0;
});

// Drive the full JSON pipeline through the real runner, step by step, exactly as the durable
// runner (workflows/pipeline-run.ts) does. Returns the outputs map + the audit trail.
async function drivePipeline(def: PipelineDef) {
	const outputs: Record<string, unknown> = {};
	const trail: AuditEntry[] = [];
	const results: StepResult[] = [];
	for (let i = 0; i < def.steps.length; i++) {
		const step = def.steps[i];
		const r = await executePipelineStep(ctx, step, i, outputs, params);
		results.push(r);
		outputs[stepBind(step, i)] = r.output;
		trail.push(auditStepEntry(step, i, r));
	}
	return { outputs, trail, results };
}

describe("lead-finder declarative pipeline (capstone #94 — FULL SWEEP)", () => {
	it("the JSON validates against the real runner contract (validatePipeline → null)", () => {
		expect(validatePipeline(leadFinder)).toBeNull();
	});

	it("declares the epic's params (city, type, radius) and sinks into `leads`", () => {
		const def = leadFinder as unknown as PipelineDef;
		expect(Object.keys(def.params ?? {}).sort()).toEqual(["city", "radius", "type"]);
		expect(def.sink?.collection).toBe("leads");
		expect(def.sink?.keyField).toBe("place_id");
	});

	it("uses the full-sweep step chain (geocode→fan_out→http_request/forEach→flatten→map→enrich→filter→dedupe)", () => {
		const def = leadFinder as unknown as PipelineDef;
		expect(def.steps.map((s) => s.tool)).toEqual([
			"geocode", "fan_out", "http_request", "flatten", "map", "enrich", "map", "filter", "dedupe_upsert",
		]);
		// the Places request runs once PER grid cell (forEach over grid.cells).
		const places = def.steps.find((s) => s.tool === "http_request")!;
		expect(places.forEach).toEqual({ $ref: "grid.cells" });
		// per-cell body plugs the cell's lat/lng via the #114 dotted-item convention.
		const center = rec(rec(rec(rec(places.inputs).body).locationRestriction).circle).center;
		expect(center.latitude).toEqual({ $param: "item.lat" });
		expect(center.longitude).toEqual({ $param: "item.lng" });
	});

	it("composes the FULL sweep end-to-end: grid → flatten → geo map → reachability enrich → filter → dedupe → sink", async () => {
		const def = leadFinder as unknown as PipelineDef;
		const { outputs } = await drivePipeline(def);

		// fan_out produced the grid; http_request ran once per cell → an ARRAY of per-cell
		// envelopes; flatten (path:"data") collapsed them to a flat list of per-PLACE records.
		const grid = outputs.grid as { cells: unknown[] };
		expect(grid.cells.length).toBe(25); // extent 2 / step 1 → (2*2+1)^2
		expect(Array.isArray(outputs.pages)).toBe(true);
		const flat = (outputs.flat as { items: unknown[] }).items;
		// 3 distinct businesses across cells + 1 duplicate (Corner Espresso re-seen) = 4 records.
		expect(flat.length).toBe(4);

		// map: geo fields populated from Google's typed addressComponents (the #116 fix).
		const shaped = (outputs.shaped as { items: Array<Record<string, unknown>> }).items;
		const corner = shaped.find((r) => r.place_id === "ChIJ_no_site")!;
		expect(corner.city).toBe("Newtown");
		expect(corner.suburb).toBe("Marrickville");
		expect(corner.state).toBe("New South Wales");
		expect(corner.country).toBe("Australia");
		expect(corner.category).toBe("cafe");
		expect(corner.status).toBe("new");

		// enrich: reachability probed per record + MERGED back under `reachable` (the #115 fix).
		const enriched = (outputs.enriched as { items: Array<Record<string, unknown>> }).items;
		const live = enriched.find((r) => r.place_id === "ChIJ_live_site")!;
		const dead = enriched.find((r) => r.place_id === "ChIJ_dead_site")!;
		expect(live.reachable).toMatchObject({ ok: true, code: 200 });
		expect(dead.reachable).toMatchObject({ ok: false, code: null });

		// classify: website_status derived (none | unreachable | reachable) via map `$cond`,
		// and websiteUri renamed to website_url — so records match the `leads` collection
		// schema + the agent's website_status counts.
		const classified = (outputs.classified as { items: Array<Record<string, unknown>> }).items;
		expect(classified.find((r) => r.place_id === "ChIJ_no_site")!.website_status).toBe("none");
		expect(classified.find((r) => r.place_id === "ChIJ_dead_site")!.website_status).toBe("unreachable");
		expect(classified.find((r) => r.place_id === "ChIJ_live_site")!.website_status).toBe("reachable");
		expect(classified.find((r) => r.place_id === "ChIJ_live_site")!.website_url).toBe("https://beanmachine.example");

		// filter (no-website OR unreachable): BOTH the no-website AND the dead-site survive;
		// the live-site is excluded. This is the full epic filter, not just the "no-website" half.
		// The duplicate Corner Espresso also survives the filter (it's still no-website) — dedupe
		// happens at the SINK, not in the filter — so filter keeps 3 (2 unique + 1 dup).
		const leads = (outputs.leads as { items: Array<Record<string, unknown>> }).items;
		const keptIds = leads.map((l) => l.place_id).sort();
		expect(keptIds).toEqual(["ChIJ_dead_site", "ChIJ_no_site", "ChIJ_no_site"]);
		expect(keptIds).not.toContain("ChIJ_live_site");

		// sink: dedupe_upsert by place_id collapsed the duplicate Corner Espresso → each lead once.
		expect(upserted.map((r) => r.place_id).sort()).toEqual(["ChIJ_dead_site", "ChIJ_no_site"]);
	});

	it("dedupe by place_id: re-running the pipeline does not double-insert", async () => {
		const def = leadFinder as unknown as PipelineDef;
		await drivePipeline(def);
		cellCounter = 0; // second sweep re-seeds the same cells
		await drivePipeline(def);
		expect(upserted.map((r) => r.place_id).sort()).toEqual(["ChIJ_dead_site", "ChIJ_no_site"]);
	});

	it("attaches a per-record audit trail (attachAudit) with a step-by-step decision log", async () => {
		const def = leadFinder as unknown as PipelineDef;
		const { outputs, trail } = await drivePipeline(def);
		const leads = (outputs.leads as { items: unknown[] }).items;
		const records = attachAudit(leads, trail, def.sink!.collection);
		expect(records.length).toBe(3); // the two unique leads + the pre-dedupe duplicate
		const audit = records[0].audit as AuditEntry[];
		// trail = one entry per pipeline step + a final sink line.
		expect(audit.length).toBe(def.steps.length + 1);
		expect(audit[audit.length - 1]).toMatchObject({ step: "sink", detail: 'upserted into "leads"' });
		for (const e of audit) {
			expect(typeof e.step).toBe("string");
			expect(typeof e.detail).toBe("string");
			expect(typeof e.at).toBe("string");
		}
	});

	// ── CLOSED-GAP PROOFS — the four places this class of agent could NOT compose before,
	//    now proven to WORK. Each was a #94 child issue (#113–#116); the assertions FLIP from
	//    asserting-the-limitation to asserting-it-works.

	it("GAP #1 CLOSED (grid fan-out flatten, #113): array-of-arrays collapses to per-place records", async () => {
		// A forEach http_request binds an ARRAY of per-cell envelopes; flatten(path:"data")
		// lifts each cell's places and concatenates → one flat record per place, not per cell.
		const perCell = [
			{ status: 200, data: [{ place_id: "a" }] },
			{ status: 200, data: [{ place_id: "b" }, { place_id: "c" }] },
		];
		const r = JSON.parse((await realHandler("flatten")({} as never, { items: perCell, path: "data" })).content);
		expect(r.count).toBe(3); // 3 PLACES (was: 2 cells)
		expect(r.items.map((x: { place_id: string }) => x.place_id)).toEqual(["a", "b", "c"]);
	});

	it("GAP #2 CLOSED (forEach dotted item, #114): item.lat / item.websiteUri resolve in a body", () => {
		const scope = { outputs: {}, params: {}, item: { lat: -33.9, websiteUri: "https://x" } };
		expect(resolveInputValue({ $param: "item" }, scope)).toEqual({ lat: -33.9, websiteUri: "https://x" });
		expect(resolveInputValue({ $param: "item.lat" }, scope)).toBe(-33.9); // dotted access WORKS
		expect(resolveInputValue({ $param: "item.websiteUri" }, scope)).toBe("https://x");
	});

	it("GAP #3 CLOSED (enrich-merge, #115): http_reachable merges back onto each place by identity", async () => {
		// enrich runs http_reachable per item and writes {ok,code} under `reachable` on a COPY —
		// so filter can test reachable.ok. No index-fragile zip; the flag rides ITS own place.
		const places = [
			{ place_id: "a", websiteUri: "https://beanmachine.example" }, // live in the mock
			{ place_id: "b", websiteUri: "https://oldroasters.example" }, // dead in the mock
		];
		const enriched = JSON.parse(
			(await realHandler("enrich")(ctx as never, { items: places, tool: "http_reachable", input: { url: { $item: "websiteUri" } }, as: "reachable" })).content,
		);
		expect(rows(enriched.items).find((x) => x.place_id === "a")?.reachable).toMatchObject({ ok: true });
		expect(rows(enriched.items).find((x) => x.place_id === "b")?.reachable).toMatchObject({ ok: false });
	});

	it("GAP #4 CLOSED (addressComponents type-select, #116): map populates geo from Google's typed array", async () => {
		const ac = BUSINESSES.cellA[0].addressComponents;
		// type-predicate getPath selects the element whose types[] contains the token.
		expect(getPath(ac, "[types~=locality].longText")).toBeUndefined(); // needs a named array field
		const shaped = JSON.parse(
			(await realHandler("map")({} as never, {
				items: [{ addressComponents: ac }],
				extract: {
					city: "addressComponents[types~=locality].longText",
					state: "addressComponents[types~=administrative_area_level_1].longText",
					country: "addressComponents[types~=country].longText",
				},
			})).content,
		);
		expect(shaped.items[0].city).toBe("Newtown");
		expect(shaped.items[0].state).toBe("New South Wales");
		expect(shaped.items[0].country).toBe("Australia");
	});
});
