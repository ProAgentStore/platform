/**
 * Timestamps for the chat transcript (#336).
 *
 * Loop and system entries already carry `createdAt`; nothing rendered it, because the time
 * lives inside a header row that only `user` and `assistant` bubbles have. That is backwards
 * for exactly these messages: a user or assistant turn is bounded by the ones around it, so
 * you roughly know when you said it, while a loop entry reports work that ran on its own
 * schedule — minutes apart, usually while you were somewhere else.
 *
 * So the two facts worth showing are *when* and *how long since the entry above*. The gap is
 * the scanning signal ("step 3 → step 4: 2m20s"); the absolute clock time is the one that
 * makes the row consistent with its siblings.
 *
 * ── Which zone
 *
 * Local, via the SDK's `formatDateTime` — the same call the user and assistant headers make.
 * Rendering these two channels in different zones would be a worse defect than the missing
 * timestamp.
 *
 * `stampTitle` takes an explicit zone (#345). It used to pass `undefined` to `toLocaleString`,
 * which means THE BROWSER'S zone — fine for the common case, and the two-clock defect all over
 * again for the owner who set a zone different from their machine: honoured in the agent's prose
 * (#329 reads `users.preferences.timezone`) and ignored in the UI. The stored zone is the one the
 * user chose, so it wins here too; absent, the browser's is still the best guess available.
 */

/** Gaps below this are noise — several entries written in the same tick, not a pause. */
export const GAP_FLOOR_MS = 2000;

/**
 * Milliseconds since the epoch, or null when the value is missing or unparseable.
 *
 * Applies the same SQLite normalisation the SDK formatter does: D1 hands back
 * `YYYY-MM-DD HH:MM:SS` with no zone, which `Date` would read as LOCAL time — silently
 * shifting every server-written timestamp by the viewer's UTC offset.
 */
export function parseStamp(iso?: string | null): number | null {
	if (!iso) return null;
	const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso) ? `${iso.replace(" ", "T")}Z` : iso;
	const t = Date.parse(normalized);
	return Number.isNaN(t) ? null : t;
}

/**
 * A duration as the shortest thing that still says how long: `45s`, `2m20s`, `1h04m`, `3d2h`.
 *
 * Deliberately not "2 minutes 20 seconds" and not `140s`: this sits inside a centred pill on a
 * 390px screen, and the reader is scanning for an order of magnitude, not doing arithmetic.
 */
export function formatGap(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) {
		const rem = s % 60;
		return rem ? `${m}m${rem}s` : `${m}m`;
	}
	const h = Math.floor(m / 60);
	if (h < 24) {
		const rem = m % 60;
		return rem ? `${h}h${String(rem).padStart(2, "0")}m` : `${h}h`;
	}
	const d = Math.floor(h / 24);
	const rem = h % 24;
	return rem ? `${d}d${rem}h` : `${d}d`;
}

/**
 * The gap between the entry above and this one, rendered — or "" when it cannot be known
 * (either timestamp missing) or is not worth saying (below the floor, or negative, which
 * means the two rows are out of order and a "-3s" would be a lie dressed as data).
 */
export function gapBetween(prev?: string | null, current?: string | null): string {
	const a = parseStamp(prev);
	const b = parseStamp(current);
	if (a === null || b === null) return "";
	const delta = b - a;
	if (delta < GAP_FLOOR_MS) return "";
	return formatGap(delta);
}

/**
 * The hover text for a stamp: the full local time WITH the zone named.
 *
 * The zone is the whole point — see the note above. It is on `title` rather than in the pill
 * because naming the zone on every row costs width the mobile layout does not have (#333), and it
 * is only needed when a reader is reconciling two clocks.
 *
 * `timeZone` is the owner's stored zone (`users.preferences.timezone`, via `accountTimezone.ts`).
 * Omitted or unresolvable ⇒ the browser's own zone, which is what this did before #345 — a stored
 * zone this runtime's tz database does not carry must degrade to a readable time, never to "".
 */
export function stampTitle(iso?: string | null, timeZone?: string): string {
	const t = parseStamp(iso);
	if (t === null) return "";
	const d = new Date(t);
	try {
		return d.toLocaleString(undefined, { timeZoneName: "short", ...(timeZone ? { timeZone } : {}) });
	} catch {
		try {
			return d.toLocaleString(undefined, { timeZoneName: "short" });
		} catch {
			return d.toLocaleString();
		}
	}
}
