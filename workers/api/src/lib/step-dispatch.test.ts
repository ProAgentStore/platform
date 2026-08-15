// What a step handler DISPATCHES, derived from the source rather than remembered (#396).
//
// This is the fix, not the declarations it checks. The bug was a second list: the pre-flight read
// `steps[].tool` while three handlers reached `runRegistryTool` with a name that appeared nowhere
// in the definition, and nothing connected the two — so `geocode` and `fan_out` quietly needed
// `http_request`, an exempt-looking pipeline passed attach AND kick, and the run was refused
// part-way through after it had already spent. Replacing that with a hand-kept table beside
// `steps.ts` would be the same defect one file over.
//
// So the table is checked against the handlers themselves: every `runRegistryTool` call in a module
// that DECLARES tools must be covered by the enclosing tool's `dispatches` / `dispatchesFromInput`,
// and every declaration must have a call site. Add a step that calls a connector tool and forget to
// declare it, and this fails before it can ship.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getRegistryTool, registryTools } from "./tool-registry.js";
import { undeclaredPipelineTools } from "./pipeline-tool-policy.js";
import leadFinder from "./pipelines/lead-finder.json" with { type: "json" };

const SRC = resolve(__dirname, "..");

/**
 * Modules that dispatch a tool the CALLER named, not one they nested inside a handler of their own.
 *
 * These are surfaces (chat, the /tools route, the pipeline runner) plus the dispatcher itself. They
 * have nothing to declare, because the tool they run is the tool someone asked for. Pinned by name
 * so a NEW module that starts dispatching has to be classified deliberately: either it is another
 * surface, or it is a handler and it owes a declaration.
 */
const DISPATCH_SURFACES = new Set([
	// The dispatcher.
	"lib/tool-registry.ts",
	// The pipeline runner — runs the tool each step names.
	"lib/pipeline.ts",
	// The chat runtime — runs the tool the model called.
	"agent-think.ts",
	// POST /v1/instances/:id/tools/:name — runs the tool the caller named.
	"routes/tools.ts",
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) sourceFiles(p, out);
		else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(p);
	}
	return out;
}

/** Comment lines stripped: this file's own neighbours explain the dispatches in prose, and a guard
 *  that counted the explanation as a call site would train the reader to ignore it. */
function codeLines(file: string): string[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? "" : l));
}

/** What one handler-declaring module dispatches: enclosing tool → the names it reaches. A dynamic
 *  name (a variable rather than a literal) is recorded as `$input`. */
function dispatchesInFile(file: string): Map<string, Set<string>> {
	const found = new Map<string, Set<string>>();
	let enclosing = "";
	for (const line of codeLines(file)) {
		// The `name: "…"` of a ToolDef literal — the nearest one above a call site is its owner.
		const decl = /^\s*name:\s*"([a-z0-9_]+)"/.exec(line);
		if (decl) enclosing = decl[1];
		const call = /runRegistryTool\(\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))/.exec(line);
		if (!call) continue;
		expect(enclosing, `${relative(SRC, file)}: a runRegistryTool call outside any ToolDef`).not.toBe("");
		const names = found.get(enclosing) ?? new Set<string>();
		names.add(call[1] ?? "$input");
		found.set(enclosing, names);
	}
	return found;
}

/** The table as the SOURCE states it: every nested dispatch, by the tool that makes it. */
const FROM_SOURCE: Map<string, Set<string>> = (() => {
	const out = new Map<string, Set<string>>();
	for (const file of sourceFiles(SRC)) {
		const rel = relative(file === SRC ? SRC : SRC, file).replace(/\\/g, "/");
		if (DISPATCH_SURFACES.has(rel)) continue;
		if (!/runRegistryTool\(/.test(readFileSync(file, "utf8"))) continue;
		for (const [tool, names] of dispatchesInFile(file)) out.set(tool, names);
	}
	return out;
})();

/** The table as the DECLARATIONS state it, in the same shape. */
const FROM_DECLARATIONS: Map<string, Set<string>> = (() => {
	const out = new Map<string, Set<string>>();
	for (const t of registryTools()) {
		const names = new Set<string>(t.dispatches ?? []);
		if (t.dispatchesFromInput) names.add("$input");
		if (names.size) out.set(t.name, names);
	}
	return out;
})();

const asObject = (m: Map<string, Set<string>>) =>
	Object.fromEntries([...m].map(([k, v]): [string, string[]] => [k, [...v].sort()]).sort(([a], [b]) => a.localeCompare(b)));

describe("a step handler's declared dispatches match what it actually calls", () => {
	it("declares every nested runRegistryTool call, and nothing it does not make", () => {
		// Both directions on purpose. A missing declaration is the #396 bug (refused mid-run); a
		// stale one refuses a pipeline at attach over a tool nothing reaches, which reads as the
		// platform being broken and is just as expensive to debug.
		expect(asObject(FROM_DECLARATIONS)).toEqual(asObject(FROM_SOURCE));
	});

	it("is the set the issue named, so a silent shrink is visible too", () => {
		expect(asObject(FROM_SOURCE)).toEqual({
			// `pages` mode drives an http_request cursor.
			fan_out: ["http_request"],
			// The tool to run per record comes from `inputs.tool`.
			enrich: ["$input"],
			// Places Text Search, through the #95 tool for vault api-key injection.
			geocode: ["http_request"],
		});
	});

	it("names only tools that exist in the registry", () => {
		for (const t of registryTools()) {
			for (const nested of t.dispatches ?? []) expect(getRegistryTool(nested), `${t.name} → ${nested}`).toBeTruthy();
		}
	});

	it("makes the reference lead-finder need http_request from its FIRST step", () => {
		// The #394 audit's point, pinned: that pipeline names `http_request` at step 2, so it was
		// already refused up front — but step 0 is `geocode`, so deleting the explicit step would
		// NOT remove the requirement. The declaration is needed twice over, and only one of the two
		// is visible in the definition.
		const uses = undeclaredPipelineTools(leadFinder, { surfaces: [], runtime: null, workflow: null, tools: [], boardColumns: [] }, getRegistryTool);
		expect(uses).toEqual([{ tool: "http_request", index: 0, step: "geocode", via: "dispatch" }]);
	});

	it("only declares an input key the tool's own schema accepts", () => {
		// A key nothing can set is a declaration that never resolves — the pre-flight would then
		// look complete while reading a field the author cannot write.
		for (const t of registryTools()) {
			if (!t.dispatchesFromInput) continue;
			expect(Object.keys(t.jsonSchema.properties), t.name).toContain(t.dispatchesFromInput);
		}
	});
});
