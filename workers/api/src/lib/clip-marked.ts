/**
 * The one way to shorten agent-visible text (#898): cut it, and SAY SO, with both numbers.
 *
 * A value an agent, the orchestrator or a stored record reads must arrive whole, in advertised
 * pages, or marked. A silent `.slice(0, N)` is how a GitHub comment ended at "…4. O" and an agent
 * acted on it as if it were complete. The count is the point: "truncated" alone leaves the reader
 * unable to tell whether it lost a sentence or 90% of the document, and it guesses generously.
 *
 * `keep: "tail"` is for logs and terminal panes, where the newest text is at the end. `within`
 * makes the result, marker included, no longer than `max` — for a value a later layer bounds again,
 * so it is not cut (and marked) twice.
 */
export function clipMarked(value: unknown, max: number, opts: { keep?: "head" | "tail"; what?: string; within?: boolean } = {}): string {
	const s = String(value ?? "");
	if (s.length <= max) return s;
	const what = opts.what ?? "characters";
	const marker = (shown: number) => `[cut: showing the ${opts.keep === "tail" ? "last" : "first"} ${shown} of ${s.length} ${what}]`;
	const shown = opts.within ? Math.max(0, max - marker(max).length - 1) : max;
	if (opts.keep === "tail") return `${marker(shown)}\n${s.slice(-shown)}`;
	return `${s.slice(0, shown)}\n${marker(shown)}`;
}

/**
 * `JSON.stringify(value)` bounded to `max` characters and STILL valid JSON (#898).
 *
 * `JSON.stringify(x).slice(0, N)` cut mid-string, so the stored context failed `json_valid` and
 * `error_summary` filtered the whole row out — the bigger the context, the more certainly its error
 * vanished. Over the bound, an object keeps its small top-level fields (an `instanceId`, a status —
 * what a reader filters on) and cuts its large ones, each marked; anything else becomes an object
 * that says it was cut, carrying a marked preview.
 */
export function boundedJson(value: unknown, max: number): string {
	const full = JSON.stringify(value);
	if (full === undefined || full.length <= max) return full ?? "null";
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const small: Record<string, unknown> = {};
		const large: Array<[string, string]> = [];
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			const text = typeof v === "string" ? v : JSON.stringify(v);
			if (text === undefined) continue;
			if (text.length <= SMALL_FIELD_CHARS) small[k] = v;
			else large.push([k, text]);
		}
		const head = JSON.stringify({ ...small, truncated: true, chars: full.length });
		let share = Math.floor((max - head.length - large.length * 80) / Math.max(1, large.length));
		while (large.length && share > 0) {
			const out = JSON.stringify({ ...small, ...Object.fromEntries(large.map(([k, t]) => [k, clipMarked(t, share)])), truncated: true, chars: full.length });
			if (out.length <= max) return out;
			share -= Math.ceil((out.length - max) / large.length) + 1;
		}
	}
	let room = max - 120;
	for (;;) {
		const out = JSON.stringify({ truncated: true, chars: full.length, preview: clipMarked(full, Math.max(0, room)) });
		if (out.length <= max || room <= 0) return out;
		room -= out.length - max;
	}
}

/** A top-level field this short is kept whole when a bounded object must shrink. */
const SMALL_FIELD_CHARS = 200;
