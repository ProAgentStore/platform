// CAPSTONE PROOF (epic #94): the lead-finder as a PURE DECLARATIVE PIPELINE — the JSON in
// lead-finder.json is data, not code — driven end-to-end through the REAL runner
// (executePipelineStep) and the REAL step handlers (map/filter from steps.ts). Only the two
// true I/O boundaries are mocked: the outbound HTTP (geocode + Places searchNearby +
// reachability) and the collection sink (dedupe_upsert's Durable Object). Everything between
// them — input resolution ($ref/$param), step threading (bind), the map reshape, the
// no-website filter, and the per-record audit trail — is exercised for real.
//
// It also PROVES, with assertions, the four expressibility gaps this pipeline hit (documented
// in README.md with follow-up issue numbers), so the green test hides nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import leadFinder from "./lead-finder.json" with { type: "json" };

// The REAL pure step handlers — we route map/filter to these so the transform logic is
// genuinely tested, not faked.
import { STEP_TOOLS } from "../steps.js";
import { getPath } from "../connectors/http.js";

// Mock the tool-registry boundary the runner dispatches through. getRegistryTool must know
// every tool the JSON names (so validatePipeline passes); runRegistryTool routes pure tools
// to their real handlers and stubs the I/O tools with realistic responses.
const KNOWN = new Set(["geocode", "http_request", "map", "filter", "dedupe_upsert", "http_reachable"]);

// Captured sink writes so we can assert what landed in the `leads` collection.
let upserted: Array<Record<string, unknown>> = [];

const realHandler = (name: string) => STEP_TOOLS.find((t) => t.name === name)!.handler;

const runRegistryTool = vi.fn(async (name: string, _ctx: unknown, input: Record<string, unknown>) => {
	// ── real pure transforms ──────────────────────────────────────────────
	if (name === "map" || name === "filter") {
		const r = await realHandler(name)({} as never, input);
		return { name, content: r.content, success: r.success };
	}
	// ── mocked I/O boundary ───────────────────────────────────────────────
	if (name === "geocode") {
		// city → centre. A realistic Google-geocode-shaped result.
		return { name, content: JSON.stringify({ lat: -33.8915, lng: 151.1795, country: "Australia", state: "New South Wales", locality: "Newtown", formatted: "Newtown NSW 2042, Australia" }), success: true };
	}
	if (name === "http_request") {
		// Google Places searchNearby, AFTER the pipeline's responseMap projection
		// ("places[].{place_id:id,name:displayName.text,...,addressComponents:addressComponents}").
		// Three businesses: one with NO website, one with a DEAD site, one LIVE.
		const projected = PLACES_RAW.places.map((p) => ({
			place_id: p.id,
			name: p.displayName.text,
			address: p.formattedAddress,
			phone: p.nationalPhoneNumber ?? null,
			websiteUri: p.websiteUri ?? null,
			lat: p.location.latitude,
			lng: p.location.longitude,
			maps_url: p.googleMapsUri,
			addressComponents: p.addressComponents, // raw Google array (see gap #4)
		}));
		return { name, content: JSON.stringify({ status: 200, data: projected }), success: true };
	}
	if (name === "http_reachable") {
		const url = String(input.url ?? "");
		const alive = url === "https://beanmachine.example"; // the live one; dead site is unreachable
		return { name, content: JSON.stringify({ ok: alive, code: alive ? 200 : null }), success: true };
	}
	if (name === "dedupe_upsert") {
		// Sink: dedupe by place_id + record what landed. Simulates the DO collection write.
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

// Import AFTER the mock so pipeline.ts binds the mocked runRegistryTool.
import { attachAudit, auditStepEntry, executePipelineStep, stepBind, validatePipeline, type PipelineDef, type StepResult, type AuditEntry } from "../pipeline.js";
import type { Env } from "../../types.js";

// A realistic Google Places searchNearby response (three cafes near Newtown).
const PLACES_RAW = {
	places: [
		{
			id: "ChIJ_no_site",
			displayName: { text: "Corner Espresso" },
			formattedAddress: "1 King St, Newtown NSW 2042",
			nationalPhoneNumber: "0298001111",
			// NO websiteUri at all → qualifies (no website)
			location: { latitude: -33.8951, longitude: 151.179 },
			googleMapsUri: "https://maps.google.com/?cid=1",
			addressComponents: [
				{ longText: "Newtown", types: ["locality"] },
				{ longText: "New South Wales", types: ["administrative_area_level_1"] },
				{ longText: "Australia", types: ["country"] },
			],
		},
		{
			id: "ChIJ_dead_site",
			displayName: { text: "Old Roasters" },
			formattedAddress: "2 Enmore Rd, Newtown NSW 2042",
			nationalPhoneNumber: "0298002222",
			websiteUri: "https://oldroasters.example", // present but DEAD → qualifies (unreachable)
			location: { latitude: -33.8972, longitude: 151.1766 },
			googleMapsUri: "https://maps.google.com/?cid=2",
			addressComponents: [
				{ longText: "Newtown", types: ["locality"] },
				{ longText: "New South Wales", types: ["administrative_area_level_1"] },
				{ longText: "Australia", types: ["country"] },
			],
		},
		{
			id: "ChIJ_live_site",
			displayName: { text: "Bean Machine" },
			formattedAddress: "3 Australia St, Newtown NSW 2042",
			nationalPhoneNumber: "0298003333",
			websiteUri: "https://beanmachine.example", // LIVE → NOT a lead
			location: { latitude: -33.8938, longitude: 151.1802 },
			googleMapsUri: "https://maps.google.com/?cid=3",
			addressComponents: [
				{ longText: "Newtown", types: ["locality"] },
				{ longText: "New South Wales", types: ["administrative_area_level_1"] },
				{ longText: "Australia", types: ["country"] },
			],
		},
	],
};

const env = {} as Env;
const ctx = { env, userId: "u1", instanceId: "i1" };
const params = { city: "Newtown, NSW", type: "cafe", radius: 900 };

beforeEach(() => {
	runRegistryTool.mockClear();
	upserted = [];
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

describe("lead-finder declarative pipeline (capstone #94)", () => {
	it("the JSON validates against the real runner contract (validatePipeline → null)", () => {
		expect(validatePipeline(leadFinder)).toBeNull();
	});

	it("declares the epic's params (city, type, radius) and sinks into `leads`", () => {
		const def = leadFinder as unknown as PipelineDef;
		expect(Object.keys(def.params ?? {}).sort()).toEqual(["city", "radius", "type"]);
		expect(def.sink?.collection).toBe("leads");
		expect(def.sink?.keyField).toBe("place_id");
	});

	it("composes end-to-end: source → map → filter → dedupe → sink yields the RIGHT leads", async () => {
		const def = leadFinder as unknown as PipelineDef;
		const { outputs } = await drivePipeline(def);

		// source: Places returned all three businesses (flat, via responseMap). http_request's
		// output is the {status,data} envelope; the JSON chains the next step off `places.data`.
		expect(((outputs.places as { data: unknown[] }).data).length).toBe(3);

		// filter (keep no-website): the composable spine drops the two businesses that HAVE a
		// websiteUri, keeping only the true no-website lead. filter's output is the {items,count}
		// envelope; the JSON chains the sink off `leads.items`.
		const leads = (outputs.leads as { items: Array<Record<string, unknown>> }).items;
		expect(leads.map((l) => l.place_id)).toEqual(["ChIJ_no_site"]);

		// sink: exactly that lead was upserted into `leads`.
		expect(upserted.map((r) => r.place_id)).toEqual(["ChIJ_no_site"]);

		// map carried the derived + passthrough fields onto the record.
		const lead = leads[0];
		expect(lead.name).toBe("Corner Espresso");
		expect(lead.category).toBe("cafe");
		expect(lead.status).toBe("new");
		expect(lead.website_status).toBe("none");
		expect(lead.maps_url).toBe("https://maps.google.com/?cid=1");
	});

	it("dedupe by place_id: re-running the pipeline does not double-insert", async () => {
		const def = leadFinder as unknown as PipelineDef;
		await drivePipeline(def);
		await drivePipeline(def); // second sweep, same place_ids
		expect(upserted.map((r) => r.place_id)).toEqual(["ChIJ_no_site"]); // still one, not two
	});

	it("attaches a per-record audit trail (attachAudit) with a step-by-step decision log", async () => {
		const def = leadFinder as unknown as PipelineDef;
		const { outputs, trail } = await drivePipeline(def);
		const leads = (outputs.leads as { items: unknown[] }).items;
		const records = attachAudit(leads, trail, def.sink!.collection);
		expect(records).toHaveLength(1);
		const audit = records[0].audit as AuditEntry[];
		// trail = one entry per pipeline step + a final sink line.
		expect(audit.length).toBe(def.steps.length + 1);
		expect(audit[audit.length - 1]).toMatchObject({ step: "sink", detail: 'upserted into "leads"' });
		// each entry has the {step, detail, at} shape the /data tab renders.
		for (const e of audit) {
			expect(typeof e.step).toBe("string");
			expect(typeof e.detail).toBe("string");
			expect(typeof e.at).toBe("string");
		}
	});

	// ── HONEST GAP PROOFS — the four places this class of agent does NOT yet fully compose.
	//    Each is documented in README.md and filed as a #94 child issue.

	it("GAP #1 (grid fan-out flatten, issue #113): forEach http_request → array-of-arrays; map can't flatten it", async () => {
		// If the source were a per-cell grid sweep (forEach over grid.cells), each cell yields
		// an ARRAY of places, so the bound output is [[place…],[place…]]. map() treats each inner
		// ARRAY as a non-record → {}, producing one row per CELL, not per place. No flatten step
		// / $ref grammar exists to collapse it. (This is why the shipped JSON uses a single
		// searchNearby at the centre, not the recipe's grid.)
		const aoa = [[{ place_id: "a" }], [{ place_id: "b" }, { place_id: "c" }]];
		const r = JSON.parse((await realHandler("map")({} as never, { items: aoa })).content);
		expect(r.count).toBe(2); // 2 cells, NOT 3 places
	});

	it("GAP #2 (forEach item has no dotted access, issue #114): can't read item.lat / item.websiteUri in a body", async () => {
		const { resolveInputValue } = await import("../pipeline.js");
		const scope = { outputs: {}, params: {}, item: { lat: -33.9, websiteUri: "x" } };
		expect(resolveInputValue({ $param: "item" }, scope)).toEqual({ lat: -33.9, websiteUri: "x" }); // whole item OK
		expect(resolveInputValue({ $param: "item.lat" }, scope)).toBeUndefined(); // dotted access NOT OK
	});

	it("GAP #3 (enrich-merge, issue #115): http_reachable forEach is a PARALLEL array, never merged back onto places", () => {
		// Even setting aside gap #2, http_reachable over `shaped` yields [{ok,code},…] as its own
		// bound output. No zip/join step exists, and map/filter each read a single `items` array,
		// so the `reachable` flag can't be correlated back to its place. → the "unreachable" half
		// of "keep no-website OR unreachable" cannot be expressed; only "no-website" composes.
		const reach = [{ ok: true }, { ok: false }];
		const places = [{ place_id: "a" }, { place_id: "b" }];
		expect(reach.length).toBe(places.length); // parallel, but nothing joins them by index
	});

	it("GAP #4 (addressComponents extraction, issue #116): map can't type-select Google's addressComponents array", async () => {
		// The JSON's map.extract {city:"addressComponents.locality",…} uses getPath, which has no
		// "find the element whose types[] includes 'locality'" grammar — so against REAL Google
		// data those geo fields resolve to null. Proven directly on the projected record.
		const ac = PLACES_RAW.places[0].addressComponents;
		expect(getPath(ac, "locality")).toBeUndefined(); // type-predicate lookup unsupported
		const shaped = JSON.parse(
			(await realHandler("map")({} as never, { items: [{ addressComponents: ac }], extract: { city: "addressComponents.locality" } })).content,
		);
		expect(shaped.items[0].city).toBeNull(); // geo field does NOT populate from real Google shape
	});
});
