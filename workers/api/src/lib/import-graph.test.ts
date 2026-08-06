import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { findCycles, parseImports, strongerKind, type ImportEdge, type ImportKind } from "./import-graph.js";

/**
 * The architecture guard for #293 — the tool/connector graph, asserted rather than described.
 *
 * What was actually wrong. The tool CONTRACT (`ToolDef`, `RegistryToolCtx`) lived inside
 * `lib/tool-registry.ts`, the module that DISPATCHES tool calls. Every connector needs the
 * contract and none needs the dispatcher, so all thirteen imported it — and the dispatcher
 * imports `connectors/registry.ts`, which imports all thirteen. Twenty cycles, every one of
 * them type-only and therefore invisible at runtime.
 *
 * The fix is a leaf: `connectors/types.ts` holds the shapes and imports nothing that reaches
 * back. The catalog (`connectors/registry.ts`) is untouched in its role — still ONE entry per
 * connector, still the thing the tool registry, connectorClient, capability gating, the
 * consent gate and all three surfaces derive from. Splitting the shape out is what lets a
 * connector state what it implements without importing the list it appears in.
 *
 * Four cycles remain and are SUPPOSED to. Each is a genuine two-way need broken with a
 * deferred `await import(...)`: `steps.ts` both provides tools to the registry (`STEP_TOOLS`)
 * and calls them (`runRegistryTool`), and emits connection events into the pump that filters
 * with its own predicate. `EXPECTED_DEFERRED` below pins that set, so a NEW back-edge cannot
 * arrive quietly on the excuse that "there are already cycles here".
 */

const SRC = resolve(__dirname, "..");
const ALL_KINDS: readonly ImportKind[] = ["value", "type", "dynamic"];
const STATIC_KINDS: readonly ImportKind[] = ["value", "type"];

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) {
			if (entry !== "node_modules") sourceFiles(p, out);
		} else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(p);
	}
	return out;
}

const rel = (p: string) => relative(SRC, p).replace(/\\/g, "/");

/** `./x.js` → the `.ts` that actually holds it, relative to SRC. Non-relative specs are deps. */
function resolveSpec(fromModule: string, spec: string): string | null {
	if (!spec.startsWith(".")) return null;
	const base = resolve(SRC, dirname(fromModule), spec).replace(/\.js$/, "");
	for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
		if (existsSync(candidate)) return rel(candidate);
	}
	return null;
}

const GRAPH: Map<string, ImportEdge[]> = (() => {
	const g = new Map<string, ImportEdge[]>();
	for (const file of sourceFiles(SRC)) {
		const module = rel(file);
		// Collapse duplicate edges to the strongest kind: a module that imports both a type and
		// a value from the same neighbour has a VALUE dependency on it.
		const strongest = new Map<string, ImportKind>();
		for (const edge of parseImports(readFileSync(file, "utf8"))) {
			const prev = strongest.get(edge.spec);
			strongest.set(edge.spec, prev ? strongerKind(prev, edge.kind) : edge.kind);
		}
		g.set(module, [...strongest].map(([spec, kind]) => ({ spec, kind })));
	}
	return g;
})();

const describeCycles = (cycles: string[][]) => cycles.map((c) => c.join(" → ")).join("\n  ");

/**
 * The only modules allowed to close a cycle with a deferred import, and why. Adding one means
 * you have a genuine two-way dependency — say so here, or restructure instead.
 */
const EXPECTED_DEFERRED = new Set([
	// steps.ts declares STEP_TOOLS (which tool-registry imports) and also CALLS registry tools.
	"lib/steps.ts",
	// The pump filters with steps.ts's predicate; steps.ts emits into the pump.
	"lib/connections.ts",
	// tool-registry defers into the board/routes graph rather than importing it at module load.
	"lib/tool-registry.ts",
	"lib/pipeline.ts",
	"lib/triggers.ts",
	"lib/pipeline-run-start.ts",
]);

describe("workers/api import graph", () => {
	it("has no static import cycle anywhere", () => {
		// The one that would actually break: a real ES-module cycle runs one of the two modules
		// against a half-initialised other. Type-only cycles are erased, but they are counted
		// here too — they are what made the connector graph unreadable, and the leaf split is
		// only durable if re-introducing one fails.
		const cycles = findCycles(GRAPH, STATIC_KINDS, resolveSpec);
		expect(cycles, `static import cycles:\n  ${describeCycles(cycles)}`).toEqual([]);
	});

	it("the connector contract is a leaf — nothing it imports reaches back to it", () => {
		// This is the property that keeps the fix from silently rotting: the moment types.ts
		// imports something with a dependency on the registry or the runtime, every connector
		// is transitively coupled to tool execution again.
		const contract = "lib/connectors/types.ts";
		expect(GRAPH.has(contract)).toBe(true);
		const inCycle = findCycles(GRAPH, ALL_KINDS, resolveSpec).filter((c) => c.includes(contract));
		expect(inCycle, `${contract} must not appear in any cycle:\n  ${describeCycles(inCycle)}`).toEqual([]);
		for (const edge of GRAPH.get(contract) ?? []) {
			expect(edge.kind, `${contract} may only import types (got a ${edge.kind} import of ${edge.spec})`).toBe("type");
		}
	});

	it("connector modules never import the tool-execution runtime", () => {
		// The issue's acceptance criterion, stated as code: connector manifest metadata must be
		// importable without dragging in what dispatches a tool call. A connector declares tools;
		// it must not depend on the thing that runs them, or the two can never be reasoned about
		// (or reviewed, or generated) separately.
		const offenders: string[] = [];
		for (const [module, edges] of GRAPH) {
			if (!module.startsWith("lib/connectors/")) continue;
			for (const edge of edges) {
				if (resolveSpec(module, edge.spec) === "lib/tool-registry.ts") offenders.push(`${module} (${edge.kind})`);
			}
		}
		expect(offenders, `connector modules importing lib/tool-registry.ts: ${offenders.join(", ")}`).toEqual([]);
	});

	it("the remaining cycles are all closed by a deliberate deferred import", () => {
		// Not "there are no cycles" — there are four, and they are the honest shape of a
		// mutual dependency. What must stay true is that every one of them is broken at RUNTIME
		// by an `await import(...)`, and that the modules doing it are the ones we decided on.
		const cycles = findCycles(GRAPH, ALL_KINDS, resolveSpec);
		for (const cycle of cycles) {
			const members = cycle.slice(0, -1);
			const deferrers = members.filter((m) => (GRAPH.get(m) ?? []).some((e) => e.kind === "dynamic" && members.includes(resolveSpec(m, e.spec) ?? "")));
			expect(deferrers.length, `cycle has no deferred edge to break it: ${cycle.join(" → ")}`).toBeGreaterThan(0);
			for (const m of members) expect(EXPECTED_DEFERRED.has(m), `${m} joined a deferred-import cycle without being declared: ${cycle.join(" → ")}`).toBe(true);
		}
	});
});

describe("parseImports classifies the three edge kinds", () => {
	const kindOf = (src: string) => parseImports(src)[0];

	it("reads `import type` as erased", () => {
		expect(kindOf(`import type { ToolDef } from "./types.js";`)).toEqual({ spec: "./types.js", kind: "type" });
	});

	it("reads a clause whose every binding is `type` as erased", () => {
		// The form the connector modules actually use. Missing it would classify half the
		// graph as runtime and make the whole guard lie in the dangerous direction.
		expect(kindOf(`import { type A, type B } from "./types.js";`).kind).toBe("type");
	});

	it("reads a MIXED clause as a value edge", () => {
		expect(kindOf(`import { run, type Cfg } from "./m.js";`).kind).toBe("value");
	});

	it("reads a default or namespace import as a value edge", () => {
		expect(kindOf(`import x from "./m.js";`).kind).toBe("value");
		expect(kindOf(`import * as ns from "./m.js";`).kind).toBe("value");
	});

	it("reads `await import(...)` as dynamic", () => {
		expect(kindOf(`async function f() { const { x } = await import("./m.js"); }`)).toEqual({ spec: "./m.js", kind: "dynamic" });
	});

	it("separates a type-only re-export from a value one", () => {
		expect(kindOf(`export type { A, B } from "./types.js";`).kind).toBe("type");
		expect(kindOf(`export { a } from "./m.js";`).kind).toBe("value");
	});

	it("ignores an import inside a comment-free string that is not an import", () => {
		expect(parseImports(`const s = "from './m.js'";`)).toEqual([]);
	});
});

describe("findCycles", () => {
	const graph = (spec: Record<string, [string, ImportKind][]>) => new Map(Object.entries(spec).map(([k, v]) => [k, v.map(([spec, kind]) => ({ spec, kind }))]));
	const identity = (_from: string, spec: string) => spec;

	it("finds a two-node cycle", () => {
		const c = findCycles(graph({ a: [["b", "value"]], b: [["a", "value"]] }), ["value"], identity);
		expect(c).toHaveLength(1);
	});

	it("ignores edges of a kind it was not asked about", () => {
		// The behaviour the whole guard rests on: the same graph is cyclic or acyclic depending
		// on whether erased edges count.
		const g = graph({ a: [["b", "value"]], b: [["a", "type"]] });
		expect(findCycles(g, ["value"], identity)).toEqual([]);
		expect(findCycles(g, ["value", "type"], identity)).toHaveLength(1);
	});

	it("reports one loop once, not once per entry point", () => {
		const c = findCycles(graph({ a: [["b", "value"]], b: [["c", "value"]], c: [["a", "value"]] }), ["value"], identity);
		expect(c).toHaveLength(1);
	});

	it("skips specifiers that do not resolve to a module in the graph", () => {
		expect(findCycles(graph({ a: [["hono", "value"]] }), ["value"], identity)).toEqual([]);
	});
});
