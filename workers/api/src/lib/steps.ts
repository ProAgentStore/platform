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
// The tool CONTRACT (a leaf), not the tool registry. This module is on both sides of that
// registry — it declares STEP_TOOLS, which tool-registry.ts imports, and several steps call
// `runRegistryTool`. That mutual need is real, so the calls below use a deferred
// `await import("./tool-registry.js")`: by the time one runs, both modules are initialised.
// Import it statically and the two initialise against each other. See lib/import-graph.ts.
import type { RegistryToolResult, ToolDef } from "./connectors/types.js";
import { getPath } from "./connectors/http.js";
import { safeFetch, SsrfError } from "./ssrf.js";
import { parseStepNumber, stepNumberError } from "./step-number.js";
// #308: the three steps below read a tool result as DATA, not as model input, so they unwrap the
// source-applied fence first — see `unfenceUntrusted` for why that cannot be used to escape one.
import { unfenceUntrusted } from "./untrusted-fence.js";
import { renderWithFencedValues } from "./prompt-interpolation.js"; // #750: re-fence bound values

// ── shared helpers ───────────────────────────────────────────────────────────

/** Coerce the `items` input into an array. A single object is wrapped as `[object]` so
 *  a step works on one record or many; anything else → []. */
function asArray(v: unknown): unknown[] {
	if (Array.isArray(v)) return v;
	if (v && typeof v === "object") return [v];
	return [];
}

/**
 * Did an upsert actually change anything? — the decision behind `emitOn:"update"`.
 *
 * `schemaFields`, when known, is what makes this correct. `validateRecord` persists only the
 * collection's schema fields, so a key OUTSIDE the schema is dropped by this write too and cannot
 * be a change. But a key can be IN the schema and absent from the stored record —
 * `inferCollectionFields` maps every key of the first record including null-valued ones, while
 * `validateRecord` drops the null value — and writing a real value there IS a change. An earlier
 * version skipped every key missing from the stored record, which silently dropped exactly that
 * chain link: any pipeline whose state change is "fill in a field that was null" stopped emitting.
 *
 * Without a schema we fall back to the safe direction: a non-empty incoming value for a key the
 * stored record lacks counts as changed. A missed emit breaks a chain silently; a duplicate emit
 * costs money and is visible.
 *
 * Values are compared as strings when both sides are primitives, because `validateRecord` coerces
 * by field type (a numeric value stored into a `string` field becomes `String(value)`) and that
 * coercion is not a state change. NEVER for objects — `String({})` is `"[object Object]"` for
 * every object, which would report all nested changes as no-change.
 */
export function differsFrom(
	stored: Record<string, unknown> | undefined,
	incoming: Record<string, unknown>,
	schemaFields?: ReadonlySet<string>,
): boolean {
	if (!stored) return true;
	const isEmpty = (x: unknown) => x === null || x === undefined || x === "";
	const primitive = (x: unknown) => x === null || x === undefined || typeof x !== "object";
	let comparable = 0;
	for (const [k, v] of Object.entries(incoming)) {
		// Not in the schema → not persisted → not a change.
		if (schemaFields && !schemaFields.has(k)) continue;
		if (!Object.hasOwn(stored, k)) {
			// Absent from the stored record. An empty incoming value would be dropped by
			// validateRecord too, so it changes nothing; a real value is a genuine new field.
			if (isEmpty(v)) continue;
			return true;
		}
		comparable++;
		const a = stored[k];
		if (a === v) continue;
		if (JSON.stringify(a ?? null) === JSON.stringify(v ?? null)) continue;
		if (primitive(a) && primitive(v) && String(a ?? "") === String(v ?? "")) continue;
		return true;
	}
	// Nothing was comparable and nothing new — we cannot show it is unchanged.
	return comparable === 0;
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

/** Concatenate an array-of-arrays into a flat array, `depth` levels deep (default 1). Used by
 *  the `flatten` step (#113) to collapse a grid fan-out's per-cell page arrays into one list. */
function flattenDeep(items: unknown[], depth: number): unknown[] {
	if (depth <= 0) return items.slice();
	const out: unknown[] = [];
	for (const el of items) {
		if (Array.isArray(el)) out.push(...flattenDeep(el, depth - 1));
		else out.push(el);
	}
	return out;
}

/**
 * Resolve an `enrich` input template against one item (#115). A `{$item:"path"}` node reads a
 * dotted field off the item (the documented per-item ergonomics — the sibling of the pipeline
 * runner's `{$param:"item.<path>"}` from #114); everything else passes through, recursing into
 * objects/arrays so nested `$item` references work.
 */
function resolveItemTemplate(tpl: unknown, item: unknown): unknown {
	if (tpl === null || typeof tpl !== "object") return tpl;
	if (Array.isArray(tpl)) return tpl.map((v) => resolveItemTemplate(v, item));
	const obj = tpl as Record<string, unknown>;
	if (typeof obj.$item === "string") return getPath(item, obj.$item);
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) out[k] = resolveItemTemplate(v, item);
	return out;
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
	// `derive` runs LAST and sees the source PLUS whatever extract/rename just produced —
	// otherwise a `$format`/`$cond` could only reference raw input fields, which makes it
	// useless in the common "reshape a nested API response, then compose a field from the
	// flattened result" case. src stays in scope, so this only ever widens what's visible.
	if (cfg.derive) {
		const scope = { ...src, ...out };
		for (const [toKey, val] of Object.entries(cfg.derive)) setPath(out, toKey, resolveDeriveValue(scope, val));
	}
	return out;
}

/**
 * A `derive` value is normally a constant. Two small escape hatches live in this slot:
 *
 *   • `{ "$cond": {field,op,value?}, "then": …, "else": … }` — evaluated with the SAME
 *     predicate ops as `filter` (missing/exists/falsy/eq/…), recursively (then/else may nest
 *     another `$cond`). Computes a classified field (e.g. website_status = none | unreachable
 *     | reachable) without a new step.
 *   • `{ "$format": "…{{field}}…" }` — composes a STRING from the record's own fields, using
 *     the same `{{dotted.path}}` syntax `ai_generate` renders with. Missing fields collapse to
 *     "" and the result is whitespace-tidied, so a partial record yields "Joe's Cafe Newtown"
 *     rather than "Joe's Cafe  undefined". This is the only way a pipeline can build a string
 *     out of other fields — needed wherever a step takes prose it can't template itself (a
 *     search query, a ticket title). Deliberately here rather than as a `format` step: it is
 *     the same "compute a field from this record" job `$cond` already does.
 *
 * A plain object with neither key is a literal.
 */
function resolveDeriveValue(item: unknown, val: unknown): unknown {
	if (isRecord(val) && isRecord(val.$cond)) {
		const c = val.$cond as unknown as FilterClause;
		return resolveDeriveValue(item, evalClause(item, c) ? val.then : val.else);
	}
	if (isRecord(val) && typeof val.$format === "string") return renderTemplate(val.$format, item);
	return val;
}

/**
 * Render `{{field}}` / `{{a.b}}` placeholders from a record — the same placeholder syntax
 * `ai_generate` uses for its prompts. A missing/null field renders as "", and the runs of
 * whitespace that leaves behind are collapsed so a gap doesn't show in the output. (The
 * collapsing is why this isn't shared with `ai_generate`: a prompt's own spacing is
 * deliberate, a composed string's is not.)
 */
export function renderTemplate(template: string, item: unknown): string {
	return template
		.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => {
			const v = getPath(item, k);
			return v == null ? "" : String(v);
		})
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

/**
 * Parse a value that is *supposed* to be JSON but came from a language model. Handles the
 * three shapes they actually emit: clean JSON, a ```json fenced block, and JSON with a
 * sentence wrapped around it. Returns null when nothing parses (callers treat that as
 * "this record's generation failed" rather than an error). A value that is ALREADY parsed
 * (object/array) passes straight through.
 */
export function parseJsonLoose(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === "object") return value;
	const raw = String(value).trim();
	if (!raw) return null;
	// Strip a fenced block: ```json … ``` or ``` … ```
	const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(raw);
	const body = (fenced ? fenced[1] : raw).trim();
	const attempt = (s: string): unknown => {
		try {
			return JSON.parse(s);
		} catch {
			return undefined;
		}
	};
	const direct = attempt(body);
	if (direct !== undefined) return direct;
	// Prose around the JSON — take the outermost {…} or […] span.
	const first = body.search(/[{[]/);
	if (first === -1) return null;
	const opener = body[first];
	const closer = opener === "{" ? "}" : "]";
	const last = body.lastIndexOf(closer);
	if (last <= first) return null;
	const span = attempt(body.slice(first, last + 1));
	return span === undefined ? null : span;
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

/**
 * The `filter` step's predicate, reusable outside a pipeline. Exported so a CONNECTION can
 * route on the same `[{field,op,value}]` vocabulary a pipeline filters with ("only leads in
 * Sydney with rating >= 4") — one predicate language for the whole system rather than a
 * second, subtly-different one for routing. Non-array `where` (or an empty one) matches
 * everything, so an unfiltered connection behaves exactly as before.
 */
export function matchesWhere(item: unknown, where: unknown, any = false): boolean {
	const clauses = (Array.isArray(where) ? where : []).filter(isRecord) as unknown as FilterClause[];
	return runFilter(item, clauses, any);
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

// ── 7. contact extraction (pure) ──────────────────────────────────────────────
// Best-effort scrape of socials + email out of web_search results (issue #99). Given the
// [{title, link, snippet}] rows web_search returns, pull the first Instagram handle URL,
// Facebook page URL, and email address seen. PURE (no I/O) — it only reads the text the
// search connector already fetched, so there's no extra network / SSRF surface here.
//
// Precision note (returned in the output): matches are heuristic. A profile/page link is
// the FIRST instagram.com/… or facebook.com/… that isn't a bare share/login/tag path; the
// email is the first RFC-ish local@domain found in any title/snippet/link (or a mailto:).
// It can miss (business has no linked socials) or mis-attribute (a shared/aggregator link),
// so downstream should treat these as candidates, not verified truth.
const IG_RE = /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)(?:\/|\?|$)/gi;
const FB_RE = /https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/([A-Za-z0-9.\-/]+?)(?:\/|\?|$)/gi;
const MAILTO_RE = /mailto:([^"'\s>?]+@[^"'\s>?]+)/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// instagram.com/<seg> paths that are NOT a profile (share/discovery/auth surfaces).
const IG_NON_PROFILE = new Set(["p", "reel", "reels", "explore", "stories", "accounts", "tv", "direct", "about"]);
// facebook.com/<seg> first-segment paths that are NOT a page (share/auth/apps).
const FB_NON_PAGE = new Set(["sharer", "sharer.php", "share", "login", "login.php", "dialog", "tr", "plugins", "help", "policies", "watch", "events", "groups", "marketplace", "profile.php"]);

/** First profile-shaped instagram.com URL across the given text blobs, else null. */
function firstInstagram(texts: string[]): string | null {
	for (const t of texts) {
		for (const m of t.matchAll(IG_RE)) {
			const handle = m[1];
			if (!IG_NON_PROFILE.has(handle.toLowerCase())) return `https://instagram.com/${handle}`;
		}
	}
	return null;
}

/** First page-shaped facebook.com URL across the given text blobs, else null. */
function firstFacebook(texts: string[]): string | null {
	for (const t of texts) {
		for (const m of t.matchAll(FB_RE)) {
			const path = m[1].replace(/\/+$/, "");
			const firstSeg = path.split("/")[0].toLowerCase();
			if (!FB_NON_PAGE.has(firstSeg) && path.length > 1) return `https://facebook.com/${path}`;
		}
	}
	return null;
}

/** First email address (mailto: preferred) across the given text blobs, else null. */
function firstEmail(texts: string[]): string | null {
	for (const t of texts) {
		MAILTO_RE.lastIndex = 0;
		const mailto = MAILTO_RE.exec(t);
		if (mailto) return mailto[1].toLowerCase();
	}
	for (const t of texts) {
		EMAIL_RE.lastIndex = 0;
		const m = EMAIL_RE.exec(t);
		if (m) return m[0].toLowerCase();
	}
	return null;
}

/** Flatten a web_search-style result row (or arbitrary record) into searchable text blobs. */
function textsOf(item: unknown): string[] {
	if (typeof item === "string") return [item];
	if (!isRecord(item)) return [];
	const out: string[] = [];
	for (const v of Object.values(item)) {
		if (typeof v === "string") out.push(v);
	}
	return out;
}

// ── the catalog ───────────────────────────────────────────────────────────────
export const STEP_TOOLS: ToolDef[] = [
	// 1 ─ map
	{
		name: "map",
		tier: "standard",
		scope: "read",
		mutates: false,
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
		mutates: false,
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

	// 2b ─ flatten (issue #113)
	{
		name: "flatten",
		tier: "standard",
		scope: "read",
		mutates: false,
		description:
			"Concatenate an array-of-arrays into a flat array (pure, no I/O). `depth` (default 1) is how many nesting levels to collapse. Optional `path`: when a `forEach` binds an array of RESULT ENVELOPES (e.g. one http_request `{status,data:[…]}` per grid cell), `path` pulls that sub-array (\"data\") from each element FIRST, so the grid fan-out (`fan_out` grid → `forEach` http_request → flatten) collapses to one flat list of records for `map`/`filter`/`dedupe_upsert`. Returns the flattened array.",
		jsonSchema: {
			type: "object",
			properties: {
				items: { type: "array", description: "The array to flatten (an array-of-arrays, or an array of result envelopes when `path` is set)." },
				depth: { type: "number", description: "Levels to flatten (default 1)." },
				path: { type: "string", description: 'Optional dotted path pulled from each element before concatenating, e.g. "data".' },
			},
			required: [],
		},
		handler: async (_ctx, input) => {
			const raw = Array.isArray(input.items) ? input.items : asArray(input.items);
			// With `path`, lift the sub-array out of each envelope element first (array of
			// {…,data:[…]} → array-of-arrays); then the same depth flatten collapses it.
			const path = typeof input.path === "string" && input.path ? input.path : "";
			const items = path ? raw.map((el) => getPath(el, path)) : raw;
			// An unreadable `depth` used to become 0 — a flatten that silently does nothing, so
			// the next step gets the array-of-arrays it was written to avoid. Same class as
			// slice's limit (#243): report it instead of picking the quiet wrong branch.
			const rawDepth = parseStepNumber(input.depth);
			if (rawDepth.kind === "invalid") return fail(stepNumberError("flatten", "depth", rawDepth.reason, "an unreadable depth would silently no-op the flatten and pass nested arrays downstream"));
			const depth = rawDepth.kind === "absent" ? 1 : Math.max(0, Math.floor(rawDepth.value));
			const out = flattenDeep(items, depth);
			return ok(JSON.stringify({ items: out, count: out.length }, null, 2));
		},
	},

	// 3 ─ dedupe_upsert
	{
		name: "dedupe_upsert",
		tier: "standard",
		scope: "read", // no external connector; writes the instance's OWN collection via the DO
		// …and THAT is why the two fields disagree here (#563). `scope:"read"` is a statement about
		// the consent gate — there is no connector to consent to, and declaring "write" would make
		// this step unreachable. `mutates:true` is the statement about the world: it INSERTs and
		// PUTs records, and it fires the agent-to-agent pump, which starts work on another instance.
		mutates: true,
		description:
			"Insert-or-update records into an instance collection, deduped by a key field (e.g. place_id). For each item: look up an existing record where key matches; if found, either skip (mode 'skip') or update in place (mode 'update', default); if not, insert. Honors the collection's unique constraint on the key field. Returns {inserted, updated, skipped, failed} — `skipped` means DELIBERATELY not written (no key, or already seen under mode 'skip'), `failed` means the write did not land; the step fails outright when every attempted write failed.",
		jsonSchema: {
			type: "object",
			properties: {
				items: { type: "array", description: "Records to upsert." },
				collection: { type: "string", description: "Target instance collection name." },
				key: { type: "string", description: "Field to dedupe on (should be unique/indexed on the collection)." },
				mode: { type: "string", description: '"update" (default, update-in-place) or "skip" (skip-if-seen).' },
				emit: { type: "string", description: "Optional event type to emit per record (e.g. 'lead.created') — feeds agent-to-agent connections (lib/connections.ts). No-op when no connection is wired." },
				emitOn: { type: "string", description: '"insert" (default — only net-new records), "update" (only records that changed), or "both". Use "update" to signal a STATE CHANGE on a record that already exists, e.g. a site going live.' },
			},
			required: ["collection", "key"],
		},
		handler: async (ctx, input) => {
			const items = asArray(input.items).filter(isRecord) as Record<string, unknown>[];
			const collection = String(input.collection || "");
			const key = String(input.key || "");
			const mode = input.mode === "skip" ? "skip" : "update";
			const emit = typeof input.emit === "string" ? input.emit.trim() : "";
			// Which transitions the event fires on. Default "insert" — the original behaviour,
			// which the lead-finder depends on. "update"/"both" exist because a CHAIN is made
			// of state changes, not just first sightings: the second agent in a chain writes to
			// a record the first one already created, so insert-only emit could never signal it
			// (e.g. a site record going drafted → live).
			const emitOn = input.emitOn === "update" || input.emitOn === "both" ? input.emitOn : "insert";
			if (!collection || !key) return fail("collection and key are required.");
			if (!ctx.env?.AGENT || !ctx.instanceId) return fail("No instance context — dedupe_upsert needs a running instance.");

			const stub = ctx.env.AGENT.get(ctx.env.AGENT.idFromName(ctx.instanceId));
			const base = `https://agent/collections/${encodeURIComponent(collection)}/records`;
			// The schema, once — it is what tells `differsFrom` which incoming keys this write will
			// actually persist. Absent (a brand-new collection) it falls back to the safe rule.
			const schemaFields = await stub
				.fetch(new Request(`https://agent/collections/${encodeURIComponent(collection)}`))
				.then(async (r) => (r.ok ? ((await r.json()) as { fields?: Array<{ name: string }> }) : null))
				.then((sc) => (sc?.fields?.length ? new Set(sc.fields.map((f) => f.name)) : undefined))
				.catch(() => undefined);
			let inserted = 0, updated = 0, skipped = 0;
			// A write that DID NOT LAND is its own outcome (#630). It used to increment `skipped` —
			// the same counter as "this item had no key" and "mode:skip, already seen" — so a run in
			// which every write failed reported `completed, added: 0, skipped: N, errors: 0`, and a
			// lost record was indistinguishable from one deliberately left alone. The concrete
			// trigger is dated: `MAX_COLLECTION_RECORDS` is 10,000, enforced by a throw, and the live
			// lead collection is filling. On the run that crosses it, and every run after it forever,
			// the sweep would have reported success and stored nothing.
			let failed = 0;
			let attempted = 0;
			let firstError = "";
			const newRows: Record<string, unknown>[] = []; // net-new inserts
			const changedRows: Record<string, unknown>[] = []; // updated-in-place records
			// The DO answers a failed write with `{error: "…"}` — "Collection \"leads\" is full (max
			// 10000 records)", "Duplicate value for unique field …". Reading only `res.ok` threw away
			// the one sentence that says which.
			const readError = async (res: Response): Promise<string> => {
				try {
					const body = (await res.text()).slice(0, 300);
					const parsed = JSON.parse(body) as { error?: unknown };
					return typeof parsed.error === "string" ? parsed.error.slice(0, 200) : body.slice(0, 200);
				} catch {
					return `HTTP ${res.status}`;
				}
			};
			for (const item of items) {
				const kv = item[key];
				if (kv === undefined || kv === null) { skipped++; continue; }
				// Look up an existing record by the key field (indexed lookup when the field is indexed/unique).
				const q = await stub.fetch(new Request(`${base}?where=${encodeURIComponent(JSON.stringify({ [key]: kv }))}&limit=1`));
				const found = q.ok ? ((await q.json()) as { records?: Array<{ id: string; data?: Record<string, unknown> }> }).records ?? [] : [];
				if (found.length > 0) {
					if (mode === "skip") { skipped++; continue; }
					// Whether the record ACTUALLY changed, decided before the write — `emitOn:
					// "update"` is documented as "only records that changed", but pushing on every
					// successful PUT made it "every record that already existed". A re-approved
					// ticket or a scheduled re-run then re-emitted `site.live` for a byte-identical
					// row, and the idempotency key cannot collapse it because a new run has a new
					// traceId — so the wired Outreach instance drafted a second pitch, and billed
					// for it, for a site that had not changed.
					const changed = differsFrom(found[0].data, item, schemaFields);
					attempted++;
					const res = await stub.fetch(new Request(`${base}/${encodeURIComponent(found[0].id)}`, {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ data: item }),
					}));
					if (res.ok) {
						updated++;
						if (changed) changedRows.push(item);
					} else {
						failed++;
						if (!firstError) firstError = await readError(res);
					}
				} else {
					attempted++;
					const res = await stub.fetch(new Request(base, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ data: item }),
					}));
					if (res.ok) {
						inserted++;
						newRows.push(item);
					} else {
						failed++;
						if (!firstError) firstError = await readError(res);
					}
				}
			}
			// Every attempted write failing means the target is broken — the collection is full, the
			// schema rejects the shape — not that the data was odd. The step says so, exactly as
			// `enrich` does for the same shape, so the run closes `failed` with the reason instead of
			// `completed` over a sweep that stored nothing. Partial failures stay successful: the
			// records that DID land are real, and the count now leaves the body via `partialFailure`.
			if (attempted > 0 && failed === attempted) {
				return fail(`dedupe_upsert: all ${failed} write(s) to "${collection}" failed — ${firstError}`);
			}
			// Fire the agent-to-agent pump for the selected transitions (deferred import breaks
			// the steps → connections → triggers cycle). Best-effort: a delivery failure must
			// never fail the sweep — it's logged to the trace by deliverEvent.
			const payloads = emitOn === "insert" ? newRows : emitOn === "update" ? changedRows : [...newRows, ...changedRows];
			let emitted = 0;
			// Why the rest of the pump's answer is kept (#630): `deliverEvent` returns
			// {connections, delivered, failed, queued, filtered, duplicate, disabled} and only
			// `delivered` was read. So an event that was PERSISTED to the outbox and is being retried
			// read as not emitted, and `filtered`/`duplicate`/`disabled` — the three numbers that
			// answer "why did my chain not fire?" — were computed and dropped on the floor.
			let delivery: Record<string, number> | null = null;
			if (emit && payloads.length && ctx.userId) {
				try {
					const { deliverEvent } = await import("./connections.js");
					const r = await deliverEvent(ctx.env, ctx.instanceId, ctx.userId, emit, payloads, { traceId: ctx.traceId ?? null });
					emitted = r.delivered;
					delivery = { connections: r.connections, delivered: r.delivered, queued: r.queued, retrying: r.failed, filtered: r.filtered, duplicate: r.duplicate, disabled: r.disabled };
				} catch { /* pump failure never breaks the sink */ }
			}
			return ok(
				JSON.stringify(
					{ inserted, updated, skipped, failed, total: items.length, ...(firstError ? { firstError } : {}), ...(emit ? { emitted } : {}), ...(delivery ? { delivery } : {}) },
					null,
					2,
				),
			);
		},
	},

	// 4 ─ paginate / fan_out
	{
		name: "fan_out",
		tier: "standard",
		scope: "read",
		// `pages` mode forwards the author's whole `request` object — METHOD included — to
		// `http_request`, once per page. So this step can POST, and an auditor told it changes
		// nothing would be wrong for the same reason they would be wrong about `http_request`
		// itself. `grid` mode mutates nothing, but a per-mode answer is not something one boolean
		// on the TOOL can carry, and the honest direction for the pair is the mutating one (#563).
		mutates: true,
		// `pages` mode drives an http_request cursor from inside this handler (#396), so the
		// pre-flight can see it. `grid` mode dispatches nothing — the declaration is per TOOL rather
		// than per mode, because a predicate over inputs is not something the source-derived guard in
		// `step-dispatch.test.ts` could keep honest, and over-declaring fails at attach where the
		// author is present.
		dispatches: ["http_request"],
		description:
			"Iterate a source over pages (drive an http_request pagination cursor) OR over a generated set (grid cells around a centre), and aggregate the items. mode 'grid': given center{lat,lng}, extentKm, stepKm → yields (2n+1)² cell centres (the lead-finder's grid). mode 'pages': repeatedly runs an http_request `request` template, threading the returned nextCursor into `cursorParam` until exhausted or `maxPages`. Returns the aggregated {items} (+ cells for grid).",
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
				// No `concurrency` knob: it was advertised here and read into a local nothing used.
				// `pages` is inherently sequential (each request needs the previous cursor) and `grid`
				// only generates cell centres, so neither mode has anything to run in parallel. A number
				// the model can set that changes nothing reads as a throughput control someone tuned.
			},
			required: [],
		},
		handler: async (ctx, input) => {
			const mode = input.mode === "pages" ? "pages" : "grid";

			if (mode === "grid") {
				const center = isRecord(input.center) ? input.center : {};
				const lat = Number((center as Record<string, unknown>).lat);
				const lng = Number((center as Record<string, unknown>).lng);
				if (!Number.isFinite(lat) || !Number.isFinite(lng)) return fail("grid mode needs center.lat and center.lng.");
				const cells = gridCells({ lat, lng }, Number(input.extentKm) || 1, Number(input.stepKm) || 1);
				return ok(JSON.stringify({ mode, cells, items: cells, count: cells.length }, null, 2));
			}

			// pages: drive http_request's nextCursor. Runs sequentially — each page needs the
			// previous page's cursor, so there is nothing here to run in parallel. Use `enrich`
			// when per-item calls should fan out; that step really does cap concurrency.
			const reqTemplate = isRecord(input.request) ? { ...(input.request as Record<string, unknown>) } : null;
			if (!reqTemplate) return fail("pages mode needs a `request` (an http_request input).");
			if (!ctx.connectorClient) return fail("pages mode needs a connector-enabled context.");
			const { runRegistryTool } = await import("./tool-registry.js");
			const cursorParam = typeof input.cursorParam === "string" ? input.cursorParam : "";
			const itemsPath = typeof input.itemsPath === "string" && input.itemsPath ? input.itemsPath : "data";
			const maxPages = Math.min(Number(input.maxPages) || 5, 50);
			const aggregated: unknown[] = [];
			let cursor: unknown ;
			let pages = 0;
			for (; pages < maxPages; pages++) {
				const inputs = isRecord(reqTemplate.inputs) ? { ...(reqTemplate.inputs as Record<string, unknown>) } : {};
				if (cursor !== undefined && cursor !== null && cursorParam) inputs[cursorParam] = cursor;
				const pageReq = { ...reqTemplate, inputs };
				const r = await runRegistryTool("http_request", ctx, pageReq);
				if (!r.success) return fail(`page ${pages + 1}: ${r.content}`);
				const parsed = JSON.parse(unfenceUntrusted(r.content)) as { data?: unknown; nextCursor?: unknown };
				const pageItems = getPath(parsed, itemsPath);
				if (Array.isArray(pageItems)) aggregated.push(...pageItems);
				else if (pageItems !== undefined && pageItems !== null) aggregated.push(pageItems);
				cursor = parsed.nextCursor;
				if (cursor === undefined || cursor === null || cursor === "") { pages++; break; }
			}
			// The loop has two exits and they mean opposite things (#640): the one above means the
			// SOURCE ran out, the one at the top means WE stopped asking with a live cursor still in
			// hand. Nothing distinguished them — `cursor` was never read again, never returned and
			// never compared — so a 5-page read of a 40-page source produced output identical to a
			// complete sweep, and the run closed `completed` with counts that read as a full one.
			// This is the #503/#394 shape: a cap treated as "all". Unlike `slice` a cursor API cannot
			// say how many records were left, so the fact reported is the one the loop actually
			// holds: the cursor was still live.
			const hasMore = cursor !== undefined && cursor !== null && cursor !== "";
			return ok(JSON.stringify({ mode, items: aggregated, count: aggregated.length, pages, maxPages, hasMore }, null, 2));
		},
	},

	// 4b ─ enrich (issue #115)
	{
		name: "enrich",
		tier: "standard",
		scope: "read",
		// Whatever the tool it is given does. `{"tool":"enrich","inputs":{"tool":"tmux_run_command"}}`
		// is the case `runRegistryTool`'s declared-tools gate exists for (see `dispatchesFromInput`
		// below) — which is the same as saying this step can mutate. It is refused unless the agent
		// declared that tool, but "refused unless configured" is not "cannot" (#563).
		mutates: true,
		// The tool to run per record arrives as an INPUT and is re-dispatched through the same
		// registry path (#396). Naming the key here lets the pre-flight resolve it whenever the
		// author wrote a literal — which every reference pipeline does — while a `$param`-supplied
		// name stays for `runRegistryTool` to refuse, as it must: that gate is the security boundary
		// and `{"tool":"enrich","inputs":{"tool":"tmux_run_command"}}` is the case it exists for.
		dispatchesFromInput: "tool",
		description:
			"Call a tool once PER record and merge each result back onto the record — the general 'enrich a list with a per-item connector call' primitive. `tool` is dispatched with `input`, a template resolved against each item: a `{\"$item\":\"path\"}` node reads that dotted field off the item (e.g. `{url:{\"$item\":\"websiteUri\"}}`). The tool's parsed result is written under key `as` on a COPY of the item. Concurrency-capped (default 4, max 20). Powers 'keep no-website OR unreachable' (enrich with http_reachable) and #99 socials/email (enrich with web_search → extract_contacts). Returns {items,count}.",
		jsonSchema: {
			type: "object",
			properties: {
				items: { type: "array", description: "Records to enrich (a single object is treated as a one-element array)." },
				tool: { type: "string", description: "Registry tool to run once per item, e.g. \"http_reachable\"." },
				input: { type: "object", description: 'Input template for `tool`; `{"$item":"path"}` reads a dotted field off the item.' },
				as: { type: "string", description: "Key on each item to write the tool's result under, e.g. \"reachable\"." },
				concurrency: { type: "number", description: "Max concurrent per-item calls (default 4, max 20)." },
			},
			required: ["tool", "as"],
		},
		handler: async (ctx, input) => {
			const items = asArray(input.items).filter(isRecord) as Record<string, unknown>[];
			const tool = String(input.tool || "");
			const as = String(input.as || "");
			if (!tool || !as) return fail("enrich needs `tool` and `as`.");
			const template = isRecord(input.input) ? input.input : {};
			const concurrency = Number(input.concurrency) || 4;
			const { runRegistryTool } = await import("./tool-registry.js");
			let failedCount = 0;
			let firstError = "";
			const out = await mapWithConcurrency(items, concurrency, async (item) => {
				const perItemInput = resolveItemTemplate(template, item) as Record<string, unknown>;
				const r = await runRegistryTool(tool, ctx, perItemInput);
				// `r.success` used to be ignored entirely, so a failure's MESSAGE was parsed as data
				// and written onto the record. With no vault key, every lead got
				// `"No API key connected for the web-search connector…"` under `as`, the step
				// returned success, the run closed "completed" with `errors: 0`, and prose landed
				// in the collection where structured data belonged — with nothing anywhere for the
				// owner to find. A typo'd tool name did the same with "Unknown tool: x".
				if (!r.success) {
					failedCount++;
					if (!firstError) firstError = r.content.slice(0, 200);
				}
				let result: unknown;
				try {
					result = JSON.parse(unfenceUntrusted(r.content));
				} catch {
					result = r.content;
				}
				return { ...item, [as]: result };
			});
			// Every item failing means the tool is misconfigured, not that the data was odd — fail
			// the step so the run says so. A partial failure stays successful (the good records are
			// real) but reports the count, so it is visible rather than silent.
			if (failedCount && failedCount === items.length) {
				return fail(`enrich: all ${failedCount} "${tool}" call(s) failed — ${firstError}`);
			}
			return ok(JSON.stringify({ items: out, count: out.length, failed: failedCount, ...(firstError ? { firstError } : {}) }, null, 2));
		},
	},

	// 5 ─ http_reachable
	{
		name: "http_reachable",
		tier: "standard",
		scope: "read",
		mutates: false,
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
		// Reads, despite dispatching a POST: Places (New) has no GET search, which is why that exact
		// endpoint is on `READ_SHAPED_POST` in connectors/http.ts. The request is built HERE, from a
		// fixed template — the caller supplies an address, never a verb or a URL — so unlike
		// `fan_out`/`enrich` there is no path from this step to a mutation.
		mutates: false,
		// Unconditionally an http_request underneath (#396) — it reuses the #95 tool for vault
		// api-key injection rather than fetching itself. A `geocode`-only pipeline on an agent that
		// declares nothing used to pass attach AND kick and die on its first step.
		dispatches: ["http_request"],
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

			// Use Places (New) Text Search — NOT the classic Geocoding API — so a key
			// restricted to places.googleapis.com (what a lead-finding agent actually has)
			// can resolve city → centre. Reuses the #95 http_request tool for vault api-key
			// injection + safeFetch; no bespoke fetch/SSRF/key handling here.
			const { runRegistryTool } = await import("./tool-registry.js");
			const r = await runRegistryTool("http_request", ctx, {
				method: "POST",
				url: "https://places.googleapis.com/v1/places:searchText",
				headers: {
					"Content-Type": "application/json",
					"X-Goog-FieldMask": "places.location,places.formattedAddress,places.addressComponents",
				},
				auth: { mode: "api-key", key: { in: "header", name: "X-Goog-Api-Key" } },
				body: { textQuery: address },
			});
			if (!r.success) return fail(`geocode request failed: ${r.content}`);
			const body = JSON.parse(unfenceUntrusted(r.content)) as { data?: unknown };
			const places = getPath(body.data, "places");
			const top = Array.isArray(places) ? places[0] : undefined;
			if (!isRecord(top)) return fail(`No geocode result for "${address}".`);

			const loc = getPath(top, "location");
			const lat = isRecord(loc) ? Number(loc.latitude) : NaN;
			const lng = isRecord(loc) ? Number(loc.longitude) : NaN;
			// Places (New) addressComponents: { longText, shortText, types } (camelCase).
			const comps = Array.isArray(getPath(top, "addressComponents")) ? (getPath(top, "addressComponents") as Array<Record<string, unknown>>) : [];
			const byType = (t: string): string | null => {
				const c = comps.find((x) => Array.isArray(x.types) && (x.types as string[]).includes(t));
				return c ? String(c.longText ?? "") : null;
			};
			const out = {
				lat: Number.isFinite(lat) ? lat : null,
				lng: Number.isFinite(lng) ? lng : null,
				country: byType("country"),
				state: byType("administrative_area_level_1"),
				locality: byType("locality") ?? byType("postal_town"),
				formatted: typeof top.formattedAddress === "string" ? top.formattedAddress : null,
			};
			return ok(JSON.stringify(out, null, 2));
		},
	},

	// 7 ─ extract_contacts
	{
		name: "extract_contacts",
		tier: "standard",
		scope: "read",
		mutates: false,
		description:
			"Extract socials + email from web_search results (pure, no I/O). Scans the [{title,link,snippet}] rows and pulls the first Instagram profile URL, Facebook page URL, and email address seen → {instagram, facebook, email} (missing fields are null). The companion to the web_search connector (#99): web_search a business name+suburb, then extract_contacts populates the instagram/facebook/email columns. Best-effort/heuristic — matches are candidates, not verified (precision noted in the output).",
		jsonSchema: {
			type: "object",
			properties: {
				items: { type: "array", description: "web_search result rows (or any records/strings with links + text to scan)." },
				fields: { type: "array", description: 'Subset of ["instagram","facebook","email"] to extract (default all three).' },
			},
			required: [],
		},
		handler: async (_ctx, input) => {
			// Accept either the raw web_search result rows, or its {results:[…]} envelope.
			const raw = isRecord(input.items) && Array.isArray((input.items as Record<string, unknown>).results)
				? (input.items as Record<string, unknown>).results
				: input.items;
			const items = asArray(raw);
			const want = new Set(
				Array.isArray(input.fields) && input.fields.length
					? (input.fields as string[])
					: ["instagram", "facebook", "email"],
			);
			// One flat pool of text blobs across every row (link + title + snippet).
			const texts = items.flatMap(textsOf);
			const out = {
				instagram: want.has("instagram") ? firstInstagram(texts) : null,
				facebook: want.has("facebook") ? firstFacebook(texts) : null,
				email: want.has("email") ? firstEmail(texts) : null,
				precision: "best-effort" as const,
			};
			return ok(JSON.stringify(out, null, 2));
		},
	},

	// 7b ─ slice — bound a list. The library could reshape, filter, enrich and flatten a list
	// but never CAP one, so any "top N" / "first few" intent had to be smuggled into a filter
	// predicate or left unbounded — and an unbounded list feeding a per-item connector call
	// (enrich / forEach) is an unbounded spend. Pure, no I/O.
	{
		name: "slice",
		tier: "standard",
		scope: "read",
		mutates: false,
		description:
			"Take a bounded window of a list (pure, no I/O). `limit` keeps at most that many records, `offset` skips that many first. The 'top N' primitive — cap a list before a per-item connector call (enrich / forEach) so a long source can't turn into unbounded spend. Returns {items, count, dropped}.",
		jsonSchema: {
			type: "object",
			properties: {
				items: { type: "array", description: "Records to take a window of." },
				limit: { type: "number", description: "Max records to keep (default: all)." },
				offset: { type: "number", description: "Records to skip first (default 0)." },
			},
			required: [],
		},
		handler: async (_ctx, input) => {
			const items = asArray(input.items);
			// `Number(x) || 0` used to map "", "abc" and false to 0 — and 0 means KEEP NOTHING,
			// while an ABSENT limit keeps everything. That asymmetry made a blank `$param` (a
			// settings/trigger field left empty) empty the list mid-chain with every downstream
			// step still succeeding: the run completed and reported nothing found. A limit you
			// asked for and didn't get is worth stopping over, so an unreadable one fails here
			// rather than silently choosing the most destructive branch available (#243).
			const rawLimit = parseStepNumber(input.limit);
			if (rawLimit.kind === "invalid") return fail(stepNumberError("slice", "limit", rawLimit.reason, "an unreadable limit would silently keep ZERO records; leave it unset to keep all"));
			const rawOffset = parseStepNumber(input.offset);
			if (rawOffset.kind === "invalid") return fail(stepNumberError("slice", "offset", rawOffset.reason, "leave it unset to start at the first record"));
			const offset = rawOffset.kind === "absent" ? 0 : Math.max(0, Math.floor(rawOffset.value));
			// An explicit 0 is still a real request for zero records; only unreadable input fails.
			const limit = rawLimit.kind === "absent" ? items.length : Math.max(0, Math.floor(rawLimit.value));
			const out = items.slice(offset, offset + limit);
			return ok(JSON.stringify({ items: out, count: out.length, dropped: items.length - out.length }, null, 2));
		},
	},

	// 7c ─ parse_json — turn a model's JSON reply into real fields. `ai_generate` writes raw
	// TEXT, so a step that asks for structured output had no way to hand its fields to the
	// next step; the alternative was one LLM call per field, which costs more AND loses
	// coherence between fields that should read as one voice. Tolerates the ```json fence
	// models add. A record whose field won't parse gets `null` — best-effort, like ai_generate.
	{
		name: "parse_json",
		tier: "standard",
		scope: "read",
		mutates: false,
		description:
			"Parse a JSON string field on each record into real structured data (pure, no I/O). Reads `field` (default \"text\" — what ai_generate writes) and writes the parsed value to `as` (default: back onto `field`). Strips a ```json code fence and any prose around the JSON. A value that won't parse becomes null rather than failing the batch, and is counted in `failed`. The companion to ai_generate when you asked the model for JSON.",
		jsonSchema: {
			type: "object",
			properties: {
				items: { type: "array", description: "Records carrying a JSON string field." },
				field: { type: "string", description: 'Field holding the JSON string (default "text").' },
				as: { type: "string", description: "Field to write the parsed value to (default: overwrite `field`)." },
			},
			required: [],
		},
		handler: async (_ctx, input) => {
			const items = asArray(input.items).filter(isRecord) as Record<string, unknown>[];
			const field = typeof input.field === "string" && input.field ? input.field : "text";
			const as = typeof input.as === "string" && input.as ? input.as : field;
			let failed = 0;
			const out = items.map((item) => {
				const parsed = parseJsonLoose(getPath(item, field));
				if (parsed === null) failed++;
				return { ...item, [as]: parsed };
			});
			return ok(JSON.stringify({ items: out, count: out.length, failed }, null, 2));
		},
	},

	// 8 ─ ai_generate — the pipeline's LLM step. Draft text per record with the owner's BYOK
	// model (Anthropic Claude, else their CF Workers AI) — no platform spend. For each item,
	// render `prompt` ({{field}} from the item) and write the reply to `as`. The Outreach agent's
	// "draft a message per lead" step. Best-effort per item (a failure leaves `as` empty).
	{
		name: "ai_generate",
		tier: "standard",
		scope: "read",
		// Spends the owner's BYOK tokens and changes nothing: the reply is returned to the next
		// step, never written anywhere. Spend is a real cost and a real question, but it is a
		// DIFFERENT question — `/v1/usage` and `usage_summary` answer it — and folding it in here
		// would make `mutates` mean "consequential", which is not a fact anyone can check (#563).
		mutates: false,
		description:
			"Generate text per record with the owner's BYOK model. For each item, render `prompt` ({{field}} / {{a.b}} interpolation from the item) and write the model's reply to the `as` field (default \"text\"). Optional `system` prompt, `model` (default claude-sonnet-4-6), `maxTokens` (default 500). The pipeline's LLM step — e.g. draft an outreach message per lead. Best-effort per item: a generation failure leaves `as` empty and never fails the batch.",
		jsonSchema: {
			type: "object",
			properties: {
				items: { type: "array", description: "Records to generate for (a single object is treated as one)." },
				prompt: { type: "string", description: "User prompt; {{field}} / {{a.b}} interpolate from each item." },
				system: { type: "string", description: "Optional system prompt (persona / rules)." },
				as: { type: "string", description: 'Output field to write the generated text to (default "text").' },
				model: { type: "string", description: "BYOK model id (default claude-sonnet-4-6)." },
				maxTokens: { type: "number", description: "Max output tokens per item (default 500)." },
			},
			required: ["prompt"],
		},
		handler: async (ctx, input) => {
			const items = asArray(input.items).filter(isRecord) as Record<string, unknown>[];
			const template = String(input.prompt || "");
			if (!template) return fail("prompt is required.");
			if (!ctx.userId) return fail("ai_generate needs an owner context (BYOK model).");
			const as = typeof input.as === "string" && input.as ? input.as : "text";
			const system = typeof input.system === "string" ? input.system : "";
			const model = typeof input.model === "string" && input.model ? input.model : "claude-sonnet-4-6";
			const maxTokens = Number.isFinite(input.maxTokens) ? Number(input.maxTokens) : 500;
			// Deferred import keeps steps.ts free of the user-ai import graph at module load.
			const { runUserWorkersAi } = await import("./user-ai.js");
			// Each substituted VALUE is fenced, the owner's template is not: the binder strips the
			// connector's source fence so `$ref` can bind, and nothing put it back before the text
			// reached a model (#750). lib/prompt-interpolation.ts has the why, `system` role included.
			const out: Record<string, unknown>[] = [];
			let generated = 0;
			for (const item of items) {
				const render = (t: string) => renderWithFencedValues(t, (k) => getPath(item, k));
				const messages: Array<{ role: string; content: string }> = [];
				if (system) messages.push({ role: "system", content: render(system) });
				messages.push({ role: "user", content: render(template) });
				try {
					const r = (await runUserWorkersAi(ctx.env, ctx.userId, model, { messages, maxTokens }, { kind: "pipeline", instanceId: ctx.instanceId })) as { response?: string };
					out.push({ ...item, [as]: r.response || "" });
					if (r.response) generated++;
				} catch {
					out.push({ ...item, [as]: "" }); // best-effort: never fail the batch
				}
			}
			return ok(JSON.stringify({ items: out, count: out.length, generated }, null, 2));
		},
	},
];
