// Core pipeline STEP library (issue #96, child of #94). A first-party catalog of reusable
// data-shaping steps — each a ToolDef (tier "standard", no connector) — so the common
// scraper/ingest/enrich/sync ops are CONFIGURATION, not bespoke code. The pipeline runner
// (#97) composes these via runRegistryTool; each is also callable directly via
// POST /v1/instances/:id/tools/:name.
//
// The proof (issue #94, the lead-finder, fully declarative):
//   geocode (city → lat/lng) → paginate/fan_out (grid cells) → http_request (Places) →
//   map (addressComponents → {city,suburb,state,country}) → http_reachable (websiteUri) →
//   filter (no-website OR unreachable) → dedupe_upsert (by place_id → `leads` collection).
//
// Steps 1-4 are PURE (no I/O) — trivially unit-testable and safe to run anywhere.
// Steps 5-6 do outbound HTTP; both go through the #95 machinery (safeFetch / the "http"
// connector) so SSRF + credential handling are NOT re-implemented here.
import type { ToolDef, RegistryToolCtx, RegistryToolResult } from "./tool-registry.js";
import { getPath } from "./connectors/http.js";
import { safeFetch, SsrfError } from "./ssrf.js";

// ── shared helpers ───────────────────────────────────────────────────────────

/** Coerce the `items` input into an array. A single object is wrapped as `[object]` so
 *  a step works on one record or many; anything else → []. */
function asArray(v: unknown): unknown[] {
	if (Array.isArray(v)) return v;
	if (v && typeof v === "object") return [v];
	return [];
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Set a value at a dotted path on a target object, creating intermediate objects. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
	const segs = path.split(".");
	let cur: Record<string, unknown> = target;
	for (let i = 0; i < segs.length - 1; i++) {
		const seg = segs[i];
		if (!isRecord(cur[seg])) cur[seg] = {};
		cur = cur[seg] as Record<string, unknown>;
	}
	cur[segs[segs.length - 1]] = value;
}

function ok(content: string): RegistryToolResult {
	return { content, success: true };
}
function fail(content: string): RegistryToolResult {
	return { content, success: false };
}

// ── 1. map ───────────────────────────────────────────────────────────────────
// Pure reshape of each item: rename fields, derive constants/copies, and extract nested
// values by the same dotted / `arr[]` grammar as the #95 responseMap (reused via getPath).
// Config:
//   rename  { fromPath: toKey }         — copy the value at fromPath to toKey
//   extract { toKey: fromPath }         — copy the value at fromPath to toKey (nested-friendly)
//   derive  { toKey: literal }          — set toKey to a constant (string/number/bool/null)
//   keep    [key, …]                    — when set, output only these top-level keys
// `rename`/`extract` write to (possibly dotted) toKey paths so you can build nested output.
function runMap(item: unknown, cfg: {
	rename?: Record<string, string>;
	extract?: Record<string, string>;
	derive?: Record<string, unknown>;
	keep?: string[];
}): Record<string, unknown> {
	const src = isRecord(item) ? item : {};
	// Start from a shallow copy so un-touched fields pass through, unless `keep` narrows it.
	const out: Record<string, unknown> = cfg.keep ? {} : { ...src };
	if (cfg.keep) for (const k of cfg.keep) if (k in src) out[k] = src[k];
	if (cfg.extract) for (const [toKey, fromPath] of Object.entries(cfg.extract)) setPath(out, toKey, getPath(src, fromPath) ?? null);
	if (cfg.rename) for (const [fromPath, toKey] of Object.entries(cfg.rename)) setPath(out, toKey, getPath(src, fromPath) ?? null);
	if (cfg.derive) for (const [toKey, val] of Object.entries(cfg.derive)) setPath(out, toKey, val);
	return out;
}

// ── 2. filter ──────────────────────────────────────────────────────────────
// Pure keep/drop over a small predicate DSL. `where` is a list of clauses (implicitly
// AND'd); `any:true` makes it OR. Each clause: { field, op, value }.
//   ops: eq ne exists missing truthy falsy in contains gt gte lt lte
// `field` is a dotted path (nested-friendly). `mode` = "keep" (default) or "drop".
type FilterClause = { field: string; op: string; value?: unknown };

function evalClause(item: unknown, c: FilterClause): boolean {
	const v = getPath(item, c.field);
	switch (c.op) {
		case "exists": return v !== undefined && v !== null;
		case "missing": return v === undefined || v === null;
		case "truthy": return !!v;
		case "falsy": return !v;
		case "eq": return v === c.value;
		case "ne": return v !== c.value;
		case "in": return Array.isArray(c.value) && c.value.includes(v as never);
		case "contains": return typeof v === "string" && typeof c.value === "string" && v.includes(c.value);
		case "gt": return typeof v === "number" && typeof c.value === "number" && v > c.value;
		case "gte": return typeof v === "number" && typeof c.value === "number" && v >= c.value;
		case "lt": return typeof v === "number" && typeof c.value === "number" && v < c.value;
		case "lte": return typeof v === "number" && typeof c.value === "number" && v <= c.value;
		default: return false;
	}
}

function runFilter(item: unknown, where: FilterClause[], any: boolean): boolean {
	if (where.length === 0) return true;
	return any ? where.some((c) => evalClause(item, c)) : where.every((c) => evalClause(item, c));
}

// ── 4b. grid fan-out (pure) ──────────────────────────────────────────────────
// Yield the cell centres of a square grid around a point: (2n+1)² cells stepping by
// `stepKm` out to ±`extentKm`, converting km → degrees (lat: 111km/°, lng: scaled by
// cos(lat)). This is the lead-finder's "grid cells around the geocoded centre".
function gridCells(center: { lat: number; lng: number }, extentKm: number, stepKm: number): Array<{ lat: number; lng: number }> {
	const step = Math.max(stepKm, 0.001);
	const steps = Math.floor(extentKm / step);
	const dLat = step / 111; // ° per step, latitude
	const cosLat = Math.max(Math.cos((center.lat * Math.PI) / 180), 0.01);
	const dLng = step / (111 * cosLat);
	const cells: Array<{ lat: number; lng: number }> = [];
	for (let i = -steps; i <= steps; i++) {
		for (let j = -steps; j <= steps; j++) {
			cells.push({ lat: +(center.lat + i * dLat).toFixed(6), lng: +(center.lng + j * dLng).toFixed(6) });
		}
	}
	return cells;
}

// ── concurrency-capped map (used by paginate/fan_out) ─────────────────────────
async function mapWithConcurrency<T, R>(items: T[], cap: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const limit = Math.max(1, Math.min(cap || 1, 20));
	const results: R[] = new Array(items.length);
	let next = 0;
	async function worker(): Promise<void> {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return results;
}

// ── 5. reachability probe (via safeFetch, #95) ────────────────────────────────
const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function probeReachable(url: string, timeoutMs: number): Promise<{ ok: boolean; code: number | null; error?: string }> {
	async function attempt(): Promise<{ ok: boolean; code: number | null; error?: string }> {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			// safeFetch (#95): https-only + SSRF-guarded + redirects re-validated per hop.
			const res = await safeFetch(url, { method: "GET", headers: { "User-Agent": BROWSER_UA }, signal: ctrl.signal });
			// "up" = any real HTTP response below 500 (403/401/404 still means a live server).
			return { ok: res.status < 500, code: res.status };
		} catch (e) {
			if (e instanceof SsrfError) return { ok: false, code: null, error: e.message };
			return { ok: false, code: null, error: e instanceof Error ? e.message : String(e) };
		} finally {
			clearTimeout(timer);
		}
	}
	const first = await attempt();
	if (first.ok || first.code !== null) return first; // a real response (even 5xx) → don't retry
	return attempt(); // one retry on a transport error / timeout
}

// ── the catalog ───────────────────────────────────────────────────────────────
export const STEP_TOOLS: ToolDef[] = [
	// 1 ─ map
	{
		name: "map",
		tier: "standard",
		scope: "read",
		description:
			"Reshape a record or array of records (pure, no I/O). `rename` copies fromPath→toKey, `extract` pulls nested values by dotted/`arr[]` path (e.g. addressComponents → {city,suburb,state,country}), `derive` sets constants, `keep` narrows to listed keys. toKey may be dotted to build nested output. Returns the reshaped array.",
		jsonSchema: {
			type: "object",
			properties: {
				items: { type: "array", description: "Records to reshape (a single object is treated as a one-element array)." },
				rename: { type: "object", description: 'Map of fromPath → toKey, e.g. {"displayName.text":"name"}.' },
				extract: { type: "object", description: 'Map of toKey → fromPath, e.g. {"city":"addressComponents.locality"} (nested-friendly).' },
				derive: { type: "object", description: 'Map of toKey → constant value, e.g. {"source":"places"}.' },
				keep: { type: "array", description: "When set, output only these top-level keys." },
			},
			required: [],
		},
		handler: async (_ctx, input) => {
			const items = asArray(input.items);
			const cfg = {
				rename: isRecord(input.rename) ? (input.rename as Record<string, string>) : undefined,
				extract: isRecord(input.extract) ? (input.extract as Record<string, string>) : undefined,
				derive: isRecord(input.derive) ? (input.derive as Record<string, unknown>) : undefined,
				keep: Array.isArray(input.keep) ? (input.keep as string[]) : undefined,
			};
			const out = items.map((it) => runMap(it, cfg));
			return ok(JSON.stringify({ items: out, count: out.length }, null, 2));
		},
	},

	// 2 ─ filter
	{
		name: "filter",
		tier: "standard",
		scope: "read",
		description:
			"Keep or drop records by a simple predicate over fields (pure, no I/O). `where` is a list of {field,op,value} clauses (AND by default, OR when `any:true`); ops: eq ne exists missing truthy falsy in contains gt gte lt lte. `mode` keep (default) or drop. Proves the lead-finder's 'keep no-website OR unreachable'. Returns the surviving array.",
		jsonSchema: {
			type: "object",
			properties: {
				items: { type: "array", description: "Records to filter." },
				where: { type: "array", description: 'Clauses: [{"field":"websiteUri","op":"missing"},{"field":"reachable","op":"eq","value":false}].' },
				any: { type: "boolean", description: "OR the clauses instead of AND (default false = AND)." },
				mode: { type: "string", description: '"keep" (default) or "drop" the matching records.' },
			},
			required: [],
		},
		handler: async (_ctx, input) => {
			const items = asArray(input.items);
			const where = (Array.isArray(input.where) ? input.where : []).filter(isRecord) as unknown as FilterClause[];
			const any = input.any === true;
			const drop = input.mode === "drop";
			const out = items.filter((it) => (drop ? !runFilter(it, where, any) : runFilter(it, where, any)));
			return ok(JSON.stringify({ items: out, count: out.length, dropped: items.length - out.length }, null, 2));
		},
	},

	// 3 ─ dedupe_upsert
	{
		name: "dedupe_upsert",
		tier: "standard",
		scope: "read", // no external connector; writes the instance's OWN collection via the DO
		description:
			"Insert-or-update records into an instance collection, deduped by a key field (e.g. place_id). For each item: look up an existing record where key matches; if found, either skip (mode 'skip') or update in place (mode 'update', default); if not, insert. Honors the collection's unique constraint on the key field. Returns {inserted, updated, skipped}.",
		jsonSchema: {
			type: "object",
			properties: {
				items: { type: "array", description: "Records to upsert." },
				collection: { type: "string", description: "Target instance collection name." },
				key: { type: "string", description: "Field to dedupe on (should be unique/indexed on the collection)." },
				mode: { type: "string", description: '"update" (default, update-in-place) or "skip" (skip-if-seen).' },
			},
			required: ["collection", "key"],
		},
		handler: async (ctx, input) => {
			const items = asArray(input.items).filter(isRecord) as Record<string, unknown>[];
			const collection = String(input.collection || "");
			const key = String(input.key || "");
			const mode = input.mode === "skip" ? "skip" : "update";
			if (!collection || !key) return fail("collection and key are required.");
			if (!ctx.env?.AGENT || !ctx.instanceId) return fail("No instance context — dedupe_upsert needs a running instance.");

			const stub = ctx.env.AGENT.get(ctx.env.AGENT.idFromName(ctx.instanceId));
			const base = `https://agent/collections/${encodeURIComponent(collection)}/records`;
			let inserted = 0, updated = 0, skipped = 0;
			for (const item of items) {
				const kv = item[key];
				if (kv === undefined || kv === null) { skipped++; continue; }
				// Look up an existing record by the key field (indexed lookup when the field is indexed/unique).
				const q = await stub.fetch(new Request(`${base}?where=${encodeURIComponent(JSON.stringify({ [key]: kv }))}&limit=1`));
				const found = q.ok ? ((await q.json()) as { records?: Array<{ id: string }> }).records ?? [] : [];
				if (found.length > 0) {
					if (mode === "skip") { skipped++; continue; }
					const res = await stub.fetch(new Request(`${base}/${encodeURIComponent(found[0].id)}`, {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ data: item }),
					}));
					if (res.ok) updated++; else skipped++;
				} else {
					const res = await stub.fetch(new Request(base, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ data: item }),
					}));
					if (res.ok) inserted++; else skipped++; // a 500 here = unique-constraint race; count as skipped
				}
			}
			return ok(JSON.stringify({ inserted, updated, skipped, total: items.length }, null, 2));
		},
	},

	// 4 ─ paginate / fan_out
	{
		name: "fan_out",
		tier: "standard",
		scope: "read",
		description:
			"Iterate a source over pages (drive an http_request pagination cursor) OR over a generated set (grid cells around a centre), with a concurrency cap, and aggregate the items. mode 'grid': given center{lat,lng}, extentKm, stepKm → yields (2n+1)² cell centres (the lead-finder's grid). mode 'pages': repeatedly runs an http_request `request` template, threading the returned nextCursor into `cursorParam` until exhausted or `maxPages`. Returns the aggregated {items} (+ cells for grid).",
		jsonSchema: {
			type: "object",
			properties: {
				mode: { type: "string", description: '"grid" (fan out over generated cells) or "pages" (drive an http_request cursor).' },
				// grid
				center: { type: "object", description: 'grid: {"lat":-33.87,"lng":151.21} centre of the grid.' },
				extentKm: { type: "number", description: "grid: half-width of the grid in km." },
				stepKm: { type: "number", description: "grid: spacing between cell centres in km." },
				// pages
				request: { type: "object", description: "pages: an http_request input object; run once per page." },
				cursorParam: { type: "string", description: "pages: which inputs key receives the previous page's nextCursor." },
				itemsPath: { type: "string", description: 'pages: dotted path into each response for the page items (default "data").' },
				maxPages: { type: "number", description: "pages: cap on pages fetched (default 5, max 50)." },
				concurrency: { type: "number", description: "Max concurrent page/cell operations (default 4, max 20)." },
			},
			required: [],
		},
		handler: async (ctx, input) => {
			const concurrency = Number(input.concurrency) || 4;
			const mode = input.mode === "pages" ? "pages" : "grid";

			if (mode === "grid") {
				const center = isRecord(input.center) ? input.center : {};
				const lat = Number((center as Record<string, unknown>).lat);
				const lng = Number((center as Record<string, unknown>).lng);
				if (!Number.isFinite(lat) || !Number.isFinite(lng)) return fail("grid mode needs center.lat and center.lng.");
				const cells = gridCells({ lat, lng }, Number(input.extentKm) || 1, Number(input.stepKm) || 1);
				return ok(JSON.stringify({ mode, cells, items: cells, count: cells.length }, null, 2));
			}

			// pages: drive http_request's nextCursor. Runs sequentially (each page needs the
			// previous cursor); `concurrency` is honored via the shared cap helper when a page
			// itself fans out — here it caps nothing beyond 1, kept for API symmetry.
			const reqTemplate = isRecord(input.request) ? { ...(input.request as Record<string, unknown>) } : null;
			if (!reqTemplate) return fail("pages mode needs a `request` (an http_request input).");
			if (!ctx.connectorClient) return fail("pages mode needs a connector-enabled context.");
			const { runRegistryTool } = await import("./tool-registry.js");
			const cursorParam = typeof input.cursorParam === "string" ? input.cursorParam : "";
			const itemsPath = typeof input.itemsPath === "string" && input.itemsPath ? input.itemsPath : "data";
			const maxPages = Math.min(Number(input.maxPages) || 5, 50);
			const aggregated: unknown[] = [];
			let cursor: unknown = undefined;
			let pages = 0;
			for (; pages < maxPages; pages++) {
				const inputs = isRecord(reqTemplate.inputs) ? { ...(reqTemplate.inputs as Record<string, unknown>) } : {};
				if (cursor !== undefined && cursor !== null && cursorParam) inputs[cursorParam] = cursor;
				const pageReq = { ...reqTemplate, inputs };
				const r = await runRegistryTool("http_request", ctx, pageReq);
				if (!r.success) return fail(`page ${pages + 1}: ${r.content}`);
				const parsed = JSON.parse(r.content) as { data?: unknown; nextCursor?: unknown };
				const pageItems = getPath(parsed, itemsPath);
				if (Array.isArray(pageItems)) aggregated.push(...pageItems);
				else if (pageItems !== undefined && pageItems !== null) aggregated.push(pageItems);
				cursor = parsed.nextCursor;
				if (cursor === undefined || cursor === null || cursor === "") { pages++; break; }
			}
			return ok(JSON.stringify({ mode, items: aggregated, count: aggregated.length, pages }, null, 2));
		},
	},

	// 5 ─ http_reachable
	{
		name: "http_reachable",
		tier: "standard",
		scope: "read",
		description:
			"Probe whether a URL is alive: GET it with a browser User-Agent, a ~12s timeout and one retry, via the SSRF-guarded safeFetch (#95). Returns {ok, code} — ok=true for any real HTTP response below 500 (a live server, even 403/404); ok=false on timeout, transport failure, blocked/private target, or 5xx. The lead-finder's 'is this site up' check on websiteUri.",
		jsonSchema: {
			type: "object",
			properties: {
				url: { type: "string", description: "The URL to probe (https, public host)." },
				timeoutMs: { type: "number", description: "Request timeout in ms (default 12000, max 30000)." },
			},
			required: ["url"],
		},
		handler: async (_ctx, input) => {
			const url = String(input.url || "");
			if (!url) return fail("url is required.");
			const timeoutMs = Math.min(Number(input.timeoutMs) || 12000, 30000);
			const r = await probeReachable(url, timeoutMs);
			return ok(JSON.stringify({ ok: r.ok, code: r.code, ...(r.error ? { error: r.error } : {}) }));
		},
	},

	// 6 ─ geocode
	{
		name: "geocode",
		tier: "standard",
		scope: "read",
		description:
			"Resolve a city/address to coordinates via the generic 'http' connector (#95) + a maps provider (Google Geocoding by default; api-key from the vault). Returns {lat,lng,country,state,locality,formatted}. The lead-finder's city→centre step; the result feeds fan_out grid mode.",
		jsonSchema: {
			type: "object",
			properties: {
				address: { type: "string", description: "City or address to geocode, e.g. 'Sydney, NSW'." },
				provider: { type: "string", description: 'Maps provider (default "google").' },
			},
			required: ["address"],
		},
		handler: async (ctx, input) => {
			const address = String(input.address || "");
			if (!address) return fail("address is required.");
			if (!ctx.connectorClient) return fail("geocode needs a connector-enabled context.");
			const provider = typeof input.provider === "string" && input.provider ? input.provider : "google";
			if (provider !== "google") return fail(`Unsupported geocode provider: ${provider}`);

			// Reuse the #95 http_request tool: it injects the vault api-key (X-Goog-Api-Key via
			// the "http" connector), goes through safeFetch, and maps the response — no bespoke
			// fetch/SSRF/key handling here.
			const { runRegistryTool } = await import("./tool-registry.js");
			const r = await runRegistryTool("http_request", ctx, {
				method: "GET",
				url: "https://maps.googleapis.com/maps/api/geocode/json",
				query: { address: "{{address}}" },
				inputs: { address },
				auth: { mode: "api-key", key: { in: "query", name: "key" } },
			});
			if (!r.success) return fail(`geocode request failed: ${r.content}`);
			const body = JSON.parse(r.content) as { data?: unknown };
			const results = getPath(body.data, "results");
			const top = Array.isArray(results) ? results[0] : undefined;
			if (!isRecord(top)) return fail(`No geocode result for "${address}".`);

			const loc = getPath(top, "geometry.location");
			const lat = isRecord(loc) ? Number(loc.lat) : NaN;
			const lng = isRecord(loc) ? Number(loc.lng) : NaN;
			const comps = Array.isArray(getPath(top, "address_components")) ? (getPath(top, "address_components") as Array<Record<string, unknown>>) : [];
			const byType = (t: string): string | null => {
				const c = comps.find((x) => Array.isArray(x.types) && (x.types as string[]).includes(t));
				return c ? String(c.long_name ?? "") : null;
			};
			const out = {
				lat: Number.isFinite(lat) ? lat : null,
				lng: Number.isFinite(lng) ? lng : null,
				country: byType("country"),
				state: byType("administrative_area_level_1"),
				locality: byType("locality") ?? byType("postal_town"),
				formatted: typeof top.formatted_address === "string" ? top.formatted_address : null,
			};
			return ok(JSON.stringify(out, null, 2));
		},
	},
];
