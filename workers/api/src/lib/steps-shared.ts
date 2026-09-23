// Tiny helpers every pipeline step shares, split out of steps.ts so a step group can live in its
// own file (steps-json.ts) without copying them. No imports beyond the result type: this stays a
// leaf, so it can never join the steps.ts ↔ tool-registry.ts cycle (see lib/import-graph.ts).
import type { RegistryToolResult } from "./connectors/types.js";

/** Coerce the `items` input into an array. A single object is wrapped as `[object]` so
 *  a step works on one record or many; anything else → []. */
export function asArray(v: unknown): unknown[] {
	if (Array.isArray(v)) return v;
	if (v && typeof v === "object") return [v];
	return [];
}

export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function ok(content: string): RegistryToolResult {
	return { content, success: true };
}
export function fail(content: string): RegistryToolResult {
	return { content, success: false };
}
