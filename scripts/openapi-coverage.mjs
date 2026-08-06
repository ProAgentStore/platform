#!/usr/bin/env node
/**
 * openapi-coverage.mjs — drift check between the live Hono route surface and the
 * served OpenAPI document (`store/openapi.yaml`).
 *
 * Why this exists (issue #209): the spec had drifted to ~55 of ~330 routes with
 * nothing to notice it. A spec that silently omits half the API is worse than one
 * that documents its own scope — so this script makes both directions of drift loud:
 *
 *   1. a route handler with no spec entry  → UNDOCUMENTED (fails unless excluded below)
 *   2. a spec path with no route handler   → PHANTOM (always fails — we document
 *      something that does not exist, which is worse than omitting it)
 *
 * How it finds routes: statically scans `workers/api/src/index.ts` for the
 * `import { x } from "./routes/y.js"` bindings and the `app.route("<prefix>", x)`
 * mounts, then scans each route module for `x.get("/…")`-style registrations on that
 * exact identifier (one file can export several routers mounted at different
 * prefixes — `storage.ts` exports both `storageRoutes` and `instanceStorageRoutes`).
 *
 * No dependencies (Node >= 22, ESM). The YAML read is a deliberate line scan of
 * top-level `paths:` keys — adding a YAML parser to the root package just for a
 * lint would be a heavier dependency than the check is worth.
 *
 * Run: `node scripts/openapi-coverage.mjs`  (or `pnpm openapi:coverage`)
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = resolve(ROOT, "workers/api/src/index.ts");
const SPEC = resolve(ROOT, "store/openapi.yaml");

// ─────────────────────────────────────────────────────────────────────────────
// EXCLUSIONS — routes deliberately left out of the public OpenAPI document.
//
// This array IS the record of intentional scope. Every entry needs a reason; if a
// route is undocumented and not listed here, this script fails. Entries are matched
// against the normalised "METHOD /path" string (path params collapsed to `{}`), as
// either a RegExp or a plain string prefix.
// ─────────────────────────────────────────────────────────────────────────────
const EXCLUSIONS = [
	{
		match: /^[A-Z]+ \/v1\/admin\//,
		reason:
			"Operator portal. Separate trust boundary (Cloudflare Access + admin role), internal-only consumer (the admin SPA), and explicitly not a stability promise — it changes without notice.",
	},
	{
		match: /^[A-Z]+ \/v1\/agents\/\{\}\/(summaries|summarize|init-collections|users\/\{\}\/context)$/,
		reason:
			"Template-agent storage internals with no first-party caller (console/CLI/MCP all use the instance-scoped equivalents). Documented at the instance level instead.",
	},
	{
		match: /^[A-Z]+ \/v1\/instances\/\{\}\/init-collections$/,
		reason: "Bootstrap helper invoked by the agent runtime itself, not by an API client.",
	},
	{
		match: /^[A-Z]+ \/v1\/instances\/\{\}\/coding\//,
		reason:
			"Coder-agent control plane (~45 routes driving a coding CLI as a child process on the subscriber's own machine — not tmux, which is the separate terminal-operator connector). Documented at summary level only — see the Coding tag in the spec — because the request/response shapes are runner-version coupled and change with the CLI, not with the API contract.",
	},
	{
		match: /^[A-Z]+ \/v1\/instances\/(\{\}\/)?(browse|behaviour)/,
		reason:
			"Console-internal helpers for the Coder browse pane and the behaviour editor (including `GET /v1/instances/behaviour-schema`); shape follows the console, not a published contract.",
	},
];

const isExcluded = (key) =>
	EXCLUSIONS.find((e) =>
		e.match instanceof RegExp ? e.match.test(key) : key.startsWith(e.match),
	);

// ─────────────────────────────────────────────────────────────────────────────
// Route inventory
// ─────────────────────────────────────────────────────────────────────────────

const METHODS = ["get", "post", "put", "patch", "delete", "all"];

/** `/v1/instances/:id/files/:fileId` and `/v1/instances/{instanceId}/files/{fileId}`
 *  must compare equal — the parameter NAME is a documentation choice, not part of
 *  the route. Collapse every param segment to `{}`, and Hono's slash-spanning
 *  catch-alls (`*`, `:name{.+}`, `:name{.*}`) to `{**}`, which matches one-or-more
 *  documented param segments (the key proxy is `/proxy/:host{.+}` in Hono but is
 *  honestly documented as `/proxy/{host}/{path}`). */
function normalise(path) {
	const segs = path.split("/").filter(Boolean);
	const out = segs.map((s) => {
		if (s === "*" || /^:[\w$]+\{\.[+*]\}$/.test(s)) return "{**}";
		if (s.startsWith(":") || (s.startsWith("{") && s.endsWith("}"))) return "{}";
		return s;
	});
	return `/${out.join("/")}`;
}

/** A catch-all key matches any spec key with >= 1 param segment in that position. */
function keyMatcher(key) {
	if (!key.includes("{**}")) return null;
	const rx = key
		.split("{**}")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("(?:\\{\\}/)*\\{\\}");
	return new RegExp(`^${rx}$`);
}

function joinPath(prefix, sub) {
	const a = prefix.replace(/\/+$/, "");
	const b = sub === "/" ? "" : sub.replace(/\/+$/, "");
	if (!b) return a || "/";
	return `${a}${b.startsWith("/") ? b : `/${b}`}`;
}

function readRoutes() {
	const src = readFileSync(INDEX, "utf8");

	// identifier → route module file
	const identFile = new Map();
	for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(\.\/routes\/[^"]+)"/g)) {
		const file = resolve(dirname(INDEX), m[2].replace(/\.js$/, ".ts"));
		if (!existsSync(file)) continue;
		for (const raw of m[1].split(",")) {
			const ident = raw.trim().split(/\s+as\s+/).pop()?.trim();
			if (ident) identFile.set(ident, file);
		}
	}

	// identifier → mount prefixes (a module may be mounted more than once)
	const identPrefixes = new Map();
	for (const m of src.matchAll(/\.route\(\s*"([^"]+)"\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
		const [, prefix, ident] = m;
		if (!identFile.has(ident)) continue;
		if (!identPrefixes.has(ident)) identPrefixes.set(ident, []);
		identPrefixes.get(ident).push(prefix);
	}

	const routes = new Map(); // "METHOD /norm" → { method, path, source }

	const add = (method, path, source) => {
		const key = `${method.toUpperCase()} ${normalise(path)}`;
		if (!routes.has(key)) routes.set(key, { method: method.toUpperCase(), path, source });
	};

	// routes registered directly on the root app in index.ts (e.g. /health)
	for (const method of METHODS) {
		const re = new RegExp(`\\bapp\\s*\\.\\s*${method}\\s*\\(\\s*"([^"*]+)"`, "g");
		for (const m of src.matchAll(re)) add(method, m[1], "index.ts");
	}

	for (const [ident, prefixes] of identPrefixes) {
		const file = identFile.get(ident);
		const body = readFileSync(file, "utf8");
		const short = file.slice(file.indexOf("workers/api/src/"));
		for (const method of METHODS) {
			const re = new RegExp(`\\b${ident}\\s*\\.\\s*${method}\\s*\\(\\s*"([^"]+)"`, "g");
			for (const m of body.matchAll(re)) {
				for (const prefix of prefixes) add(method, joinPath(prefix, m[1]), short);
			}
		}
		// A module may hand its router to helper modules that register more handlers on
		// it — `registerApplyRoutes(instanceRoutes)` in instances.ts, etc. Follow those:
		// resolve the helper's import, then scan it for handlers on ANY identifier (inside
		// the helper the router is a function parameter, so the name is arbitrary).
		for (const call of body.matchAll(
			new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*\\(\\s*${ident}\\s*\\)`, "g"),
		)) {
			const fn = call[1];
			const imp = body.match(
				new RegExp(`import\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from\\s*"(\\.[^"]+)"`),
			);
			if (!imp) continue;
			const helper = resolve(dirname(file), imp[1].replace(/\.js$/, ".ts"));
			if (!existsSync(helper)) continue;
			const hbody = readFileSync(helper, "utf8");
			const hshort = helper.slice(helper.indexOf("workers/api/src/"));
			for (const method of METHODS) {
				const re = new RegExp(
					`\\b[A-Za-z_$][\\w$]*\\s*\\.\\s*${method}\\s*\\(\\s*"(/[^"]*)"`,
					"g",
				);
				for (const m of hbody.matchAll(re)) {
					for (const prefix of prefixes) add(method, joinPath(prefix, m[1]), hshort);
				}
			}
		}
	}

	return routes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spec inventory — line scan, no YAML dependency.
// Top-level `paths:` block; path keys are 2-space indented and start with `/`,
// their operations are 4-space indented method keys.
// ─────────────────────────────────────────────────────────────────────────────
function readSpec() {
	const lines = readFileSync(SPEC, "utf8").split("\n");
	const out = new Map(); // "METHOD /norm" → { method, path }
	let inPaths = false;
	let current = null;

	for (const line of lines) {
		if (/^paths:\s*$/.test(line)) {
			inPaths = true;
			continue;
		}
		if (!inPaths) continue;
		// any other top-level key ends the paths block
		if (/^\S/.test(line)) break;
		const path = line.match(/^ {2}(\/\S*):\s*$/);
		if (path) {
			current = path[1];
			continue;
		}
		const op = line.match(/^ {4}(get|post|put|patch|delete|head|options|trace):\s*$/);
		if (op && current) {
			out.set(`${op[1].toUpperCase()} ${normalise(current)}`, {
				method: op[1].toUpperCase(),
				path: current,
			});
		}
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────

const routes = readRoutes();
const spec = readSpec();

const specKeys = [...spec.keys()];
const routeKeys = [...routes.keys()];

/** Does the spec cover this route? Exact key, or — for an `.all()` handler — any
 *  documented method on the same path, or a catch-all pattern match. */
function specCovers(key, method, path) {
	if (spec.has(key)) return true;
	const norm = normalise(path);
	const rx = keyMatcher(key);
	if (rx && specKeys.some((k) => rx.test(k))) return true;
	if (method === "ALL") {
		const anyRx = keyMatcher(`ANY ${norm}`);
		return specKeys.some((k) => {
			const bare = k.slice(k.indexOf(" ") + 1);
			return bare === norm || Boolean(anyRx?.test(`ANY ${bare}`));
		});
	}
	return false;
}

const undocumented = [];
const excluded = [];
for (const [key, r] of routes) {
	if (specCovers(key, r.method, r.path)) continue;
	const ex = isExcluded(key);
	(ex ? excluded : undocumented).push({ key, ...r, reason: ex?.reason });
}

const phantom = [];
for (const [key, s] of spec) {
	if (routes.has(key)) continue;
	const norm = normalise(s.path);
	// a documented method may be served by an `.all()` handler, and a route may be a
	// slash-spanning catch-all that this documented path falls under
	const covered = routeKeys.some((k) => {
		const [m, p] = [k.slice(0, k.indexOf(" ")), k.slice(k.indexOf(" ") + 1)];
		if (m !== s.method && m !== "ALL") return false;
		if (p === norm) return true;
		const rx = keyMatcher(`X ${p}`);
		return rx ? rx.test(`X ${norm}`) : false;
	});
	if (!covered) phantom.push({ key, ...s });
}

const total = routes.size;
const documented = total - undocumented.length - excluded.length;
const inScope = total - excluded.length;

const pct = (n, d) => (d === 0 ? "100.0" : ((n / d) * 100).toFixed(1));

console.log("OpenAPI coverage — store/openapi.yaml vs workers/api/src/routes/*.ts\n");
console.log(`  route handlers found : ${total}`);
console.log(`  documented           : ${documented}/${total} (${pct(documented, total)}% of all)`);
console.log(
	`  in-scope coverage    : ${documented}/${inScope} (${pct(documented, inScope)}% excluding ${excluded.length} intentionally-excluded)`,
);
console.log(`  spec operations      : ${spec.size}`);

if (excluded.length) {
	const byReason = new Map();
	for (const e of excluded) byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1);
	console.log(`\nExcluded by design (${excluded.length}):`);
	for (const [reason, n] of byReason) console.log(`  · ${n} route(s) — ${reason}`);
}

if (undocumented.length) {
	console.log(`\nUNDOCUMENTED (${undocumented.length}) — no spec entry and no exclusion:`);
	for (const u of undocumented.sort((a, b) => a.key.localeCompare(b.key))) {
		console.log(`  ✗ ${u.method.padEnd(6)} ${u.path}   (${u.source})`);
	}
}

if (phantom.length) {
	console.log(`\nDOCUMENTED BUT MISSING (${phantom.length}) — spec describes a route that does not exist:`);
	for (const p of phantom.sort((a, b) => a.key.localeCompare(b.key))) {
		console.log(`  ✗ ${p.method.padEnd(6)} ${p.path}`);
	}
}

if (!undocumented.length && !phantom.length) {
	console.log("\n✓ No drift: every route is documented or explicitly excluded, and every");
	console.log("  documented path resolves to a real handler.");
	process.exit(0);
}

console.log("\nFail. Either document the route, add it to EXCLUSIONS with a reason");
console.log("(scripts/openapi-coverage.mjs), or delete the stale spec entry.");
process.exit(1);
