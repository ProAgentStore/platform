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
}

export interface ErrorSignature {
	key: string;
	source: string;
	sample: string; // a representative raw message
	pattern: string; // normalized message (ids/numbers redacted)
	count: number;
	users: number; // distinct affected users
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
		let sig = map.get(key);
		if (!sig) {
			sig = {
				key,
				source: r.source,
				sample: r.message,
				pattern,
				count: 0,
				users: 0,
				firstSeen: r.created_at,
				lastSeen: r.created_at,
				lastStatus: r.status,
				lastId: r.id,
			};
			map.set(key, sig);
			seenUsers.set(key, new Set());
		}
		sig.count += 1;
		if (r.user_id) seenUsers.get(key)!.add(r.user_id);
		// Rows arrive newest-first; keep the first as "last", update first-seen as we go older.
		if (r.created_at > sig.lastSeen) { sig.lastSeen = r.created_at; sig.lastStatus = r.status; sig.lastId = r.id; sig.sample = r.message; }
		if (r.created_at < sig.firstSeen) sig.firstSeen = r.created_at;
	}
	for (const [key, sig] of map) sig.users = seenUsers.get(key)!.size;
	return [...map.values()].sort((a, b) => b.count - a.count || (a.lastSeen < b.lastSeen ? 1 : -1));
}
