// Admin error analytics (pure, unit-tested). Powers the Errors & Exceptions page:
// a filterable raw feed + a GROUPED-signature view ("this exception happened N
// times, last seen X, affecting M users") so the operator can learn from recurring
// mistakes instead of scrolling a flat log.

export interface RawError {
	id: string;
	created_at: string;
	user_id: string | null;
	source: string;
	status: number | null;
	message: string;
	context: string | null;
	/** 'error' | 'warn'. Absent on a row written before migration 0103 — treated as 'error'. */
	level?: string | null;
	/** Occurrences this row stands for. Absent/0 on a pre-0103 row — treated as 1. */
	repeat_count?: number | null;
	/** Most recent occurrence. Falls back to `created_at`. */
	last_seen_at?: string | null;
}

/** Occurrences a row accounts for. A pre-0103 row has no column and stands for exactly itself. */
export const occurrencesOf = (r: RawError): number => Math.max(1, Math.floor(Number(r.repeat_count ?? 1)) || 1);

/** When a row was last hit. Pre-0103 rows were never collapsed, so they were hit once. */
export const lastSeenOf = (r: RawError): string => r.last_seen_at || r.created_at;

export interface ErrorSignature {
	key: string;
	source: string;
	sample: string; // a representative raw message
	pattern: string; // normalized message (ids/numbers redacted)
	/** OCCURRENCES, not rows — a row that collapsed 60 repeats counts 60 (#424). */
	count: number;
	/** How many rows those occurrences are spread over. `count` far above this means collapse is
	 *  working; equal means every occurrence still has its own row. */
	rows: number;
	users: number; // distinct affected users
	/** 'error' unless EVERY occurrence in the signature is a warn. A signature that is sometimes a
	 *  real failure must not be filed under the severity of its quietest member. */
	level: string;
	firstSeen: string;
	lastSeen: string;
	lastStatus: number | null;
	lastId: string; // id of the most-recent occurrence (to open detail)
}

/**
 * Normalize a message so near-identical failures collapse into one signature:
 * redact UUIDs, long hex/ids, numbers, and quoted strings. E.g.
 * "GET /v1/instances/abc-123/runtime/status → 502" → "get /v1/instances/{id}/runtime/status → {n}".
 */
export function normalizeMessage(message: string): string {
	return (message || "")
		.toLowerCase()
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "{id}")
		.replace(/\b[0-9a-f]{16,}\b/g, "{id}")
		.replace(/"[^"]*"/g, '"{s}"')
		.replace(/\d+/g, "{n}")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200);
}

export function signatureKey(source: string, message: string): string {
	return `${source}::${normalizeMessage(message)}`;
}

/** Group raw errors into signatures, sorted by count (desc) then most-recent. */
export function summarizeErrors(rows: RawError[]): ErrorSignature[] {
	const map = new Map<string, ErrorSignature>();
	const seenUsers = new Map<string, Set<string>>();
	for (const r of rows) {
		const pattern = normalizeMessage(r.message);
		const key = `${r.source}::${pattern}`;
		const seen = lastSeenOf(r);
		let sig = map.get(key);
		if (!sig) {
			sig = {
				key,
				source: r.source,
				sample: r.message,
				pattern,
				count: 0,
				rows: 0,
				users: 0,
				level: "warn",
				firstSeen: r.created_at,
				lastSeen: seen,
				lastStatus: r.status,
				lastId: r.id,
			};
			map.set(key, sig);
			seenUsers.set(key, new Set());
		}
		// OCCURRENCES, not rows. The write side collapses an identical repeat into a counter
		// (#424), so counting rows would report "3" for a failure that happened 1809 times —
		// understating exactly the runaway the counter exists to make visible.
		sig.count += occurrencesOf(r);
		sig.rows += 1;
		if ((r.level ?? "error") !== "warn") sig.level = "error";
		if (r.user_id) seenUsers.get(key)!.add(r.user_id);
		// Rows arrive newest-first; keep the first as "last", update first-seen as we go older.
		if (seen > sig.lastSeen) { sig.lastSeen = seen; sig.lastStatus = r.status; sig.lastId = r.id; sig.sample = r.message; }
		if (r.created_at < sig.firstSeen) sig.firstSeen = r.created_at;
	}
	for (const [key, sig] of map) sig.users = seenUsers.get(key)!.size;
	return [...map.values()].sort((a, b) => b.count - a.count || (a.lastSeen < b.lastSeen ? 1 : -1));
}
