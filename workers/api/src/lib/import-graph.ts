/**
 * Import-graph analysis, pure (#293) — the two halves of "does this module graph have a
 * cycle, and does it matter?"
 *
 * The distinction the guard is built on. A TypeScript import edge comes in three kinds and
 * only one of them exists at runtime:
 *
 *   value    `import { x } from "./m.js"`        — a real ES module edge. A cycle here is a
 *                                                  live hazard: one of the two modules runs
 *                                                  with the other half-initialised, and which
 *                                                  one depends on who is imported first.
 *   type     `import type { T } from "./m.js"`   — erased by the compiler. Zero runtime edge.
 *                                                  A cycle costs nothing to execute, but it
 *                                                  makes "does A depend on B?" unanswerable
 *                                                  from the graph, which is what a reviewer
 *                                                  (and a model) reads before changing either.
 *   dynamic  `await import("./m.js")`            — resolved when the line RUNS, by which time
 *                                                  both modules are initialised. This is the
 *                                                  deliberate way to break a genuine two-way
 *                                                  need, and several modules here use it.
 *
 * A scanner that counts all three reports one undifferentiated pile — which is how #293 was
 * filed as 24 cycles when the runtime count was, and is, zero. Classifying first is the whole
 * point: it turns "20 type-only cycles" (a missing types module, fix it) apart from "4 cycles
 * whose back-edge is a documented `await import`" (already handled, leave it).
 */

export type ImportKind = "value" | "type" | "dynamic";

export interface ImportEdge {
	/** The module specifier as written, e.g. "./connectors/registry.js". */
	spec: string;
	kind: ImportKind;
}

/** value beats dynamic beats type when the same pair is imported more than once. */
const RANK: Record<ImportKind, number> = { type: 0, dynamic: 1, value: 2 };

export function strongerKind(a: ImportKind, b: ImportKind): ImportKind {
	return RANK[a] >= RANK[b] ? a : b;
}

const STATIC_IMPORT = /(?:^|\n)\s*import\s+([\s\S]*?)\s*from\s+["']([^"']+)["']/g;
const REEXPORT = /(?:^|\n)\s*export\s+(type\s+)?(?:\*|\{[\s\S]*?\})\s*from\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Every import edge in one module's source, classified.
 *
 * `import type {...}` is obviously type-only; so is `import { type A, type B }`, where every
 * named binding carries its own `type` modifier — that form is erased identically, and the
 * connector modules use it, so missing it would have mis-read half the graph as runtime.
 * A mixed clause (`import { run, type Cfg }`) is a value edge, because `run` is real.
 *
 * Deliberately regex, not the TypeScript AST: this runs in a unit test over ~250 files and
 * must not pull a compiler into the fast suite. The forms it does not model — `require`,
 * import assertions — do not appear in this Worker.
 */
export function parseImports(source: string): ImportEdge[] {
	const out: ImportEdge[] = [];
	for (const m of source.matchAll(STATIC_IMPORT)) {
		out.push({ spec: m[2], kind: isTypeOnlyClause(m[1]) ? "type" : "value" });
	}
	for (const m of source.matchAll(REEXPORT)) {
		out.push({ spec: m[2], kind: m[1] ? "type" : "value" });
	}
	for (const m of source.matchAll(DYNAMIC_IMPORT)) {
		out.push({ spec: m[1], kind: "dynamic" });
	}
	return out;
}

function isTypeOnlyClause(clause: string): boolean {
	const c = clause.trim();
	if (/^type\s/.test(c)) return true; // import type { T } / import type T
	const braced = c.match(/^\{([\s\S]*)\}$/);
	if (!braced) return false; // default or namespace import — a value
	const names = braced[1].split(",").filter((s) => s.trim());
	return names.length > 0 && names.every((s) => /^\s*type\s/.test(s));
}

/**
 * Every distinct cycle reachable over the given edge kinds, as node lists whose first and
 * last entry are the same node. Distinct by member SET, so one loop is not reported once per
 * entry point.
 */
export function findCycles(graph: Map<string, ImportEdge[]>, kinds: readonly ImportKind[], resolve: (from: string, spec: string) => string | null): string[][] {
	const allowed = new Set(kinds);
	const state = new Map<string, 0 | 1 | 2>();
	const stack: string[] = [];
	const seen = new Set<string>();
	const found: string[][] = [];

	const visit = (node: string) => {
		state.set(node, 1);
		stack.push(node);
		for (const edge of graph.get(node) ?? []) {
			if (!allowed.has(edge.kind)) continue;
			const to = resolve(node, edge.spec);
			if (!to || !graph.has(to)) continue;
			const s = state.get(to) ?? 0;
			if (s === 1) {
				const cycle = stack.slice(stack.indexOf(to));
				const key = [...cycle].sort().join("|");
				if (!seen.has(key)) {
					seen.add(key);
					found.push([...cycle, to]);
				}
			} else if (s === 0) visit(to);
		}
		stack.pop();
		state.set(node, 2);
	};

	for (const node of graph.keys()) if (!state.get(node)) visit(node);
	return found;
}
