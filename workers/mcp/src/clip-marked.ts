/**
 * Cut text an agent or a reader of the audit log will see, and SAY SO with both numbers (#898, #959).
 *
 * A copy of `clipMarked` in `workers/api/src/lib/clip-marked.ts` (head-only): the MCP Worker does
 * not import across the Worker boundary, so the one rule is kept in step by `clip-marked.test.ts`
 * asserting the same marker.
 */
export function clipMarked(value: unknown, max: number, what = "characters"): string {
	const s = String(value ?? "");
	if (s.length <= max) return s;
	return `${s.slice(0, max)}\n[cut: showing the first ${max} of ${s.length} ${what}]`;
}
