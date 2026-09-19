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
	/** The MOST RECENT occurrence's context (#538). Absent on a row collapsed before 0124. */
	last_context?: string | null;
}

/** Occurrences a row accounts for. A pre-0103 row has no column and stands for exactly itself. */
export const occurrencesOf = (r: RawError): number => Math.max(1, Math.floor(Number(r.repeat_count ?? 1)) || 1);

/** When a row was last hit. Pre-0103 rows were never collapsed, so they were hit once. */
export const lastSeenOf = (r: RawError): string => r.last_seen_at || r.created_at;

/**
 * What the retained context samples say a signature TOUCHED (#823).
 *
 * ── Why this is "seen on", not "affecting" ──
 *
 * A collapsed row keeps exactly TWO context samples — the first occurrence's and the latest
 * (`context` and `last_context`, #538) — and `instanceId` is deliberately NOT part of the collapse
 * identity, because for the sources that actually repeat the context is a per-occurrence
 * measurement and keying on it would mean never collapsing anything.
 *
 * So a row standing for sixty occurrences across four instances can only ever show two of them.
 * These fields are therefore a LOWER BOUND on what a signature touched, and every name that
 * renders them has to say so. Presenting them as the complete set would be a confident wrong
 * answer of exactly the kind the payer work (#551) and the SSH-identity work (#684) were both
 * filed about — and the temptation is real, because two names look like a list.
 */
export interface ErrorFacets {
	/** Instance ids observed in a retained sample. A lower bound — see above. */
	instances: string[];
	/** `owner/repo` values observed. Coding failures carry one; most sources carry none. */
	repos: string[];
	/** `failureClass` values observed — `infra_transient`, `runner_gone`, … (#823's bullet 2). */
	failureClasses: string[];
	/**
	 * Did a retained sample say the platform RESUMED past this, or that the run ended?
	 *
	 * Both can be true of one signature: the first attempt resumed and the last one did not. Two
	 * independent booleans rather than one verdict, because collapsing them would have to pick a
	 * winner and either choice misreports half the buckets.
	 */
	resumed: boolean;
	ended: boolean;
}

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
	/** What the retained samples say this touched. A LOWER BOUND — see {@link ErrorFacets}. */
	facets: ErrorFacets;
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

/**
 * What a grouped-errors read returns, owner-scoped (`GET /v1/errors/summary`, #823) or
 * cross-account (the admin route). Declared here rather than in either route because both shapes
 * are the same question answered over a different `WHERE`, and the console imports it directly —
 * a mirrored copy is the drift `check-console-types` exists to prevent.
 */
export interface ErrorSummaryResponse {
	/** The window grouped over. Absent on the admin route, which bounds by rows only. */
	days?: number;
	/** OCCURRENCES across every signature — not rows. */
	total: number;
	/** Rows read to produce it. Far below `total` means the write-side collapse is working. */
	rows: number;
	/** The window was FULL: `total` is a floor, not a total. Absent on a route that cannot say. */
	truncated?: boolean;
	signatures: ErrorSignature[];
}

/**
 * The well-known context keys, read off ONE retained sample.
 *
 * Tolerant by construction: the context is free-form JSON written by ~25 call sites, so a missing
 * key, a null, a number where a string was expected, or text that is not JSON at all are all
 * ordinary rather than exceptional. Anything unreadable contributes nothing and never throws —
 * a facet that could break the grouping would make the page fail on exactly the malformed row it
 * exists to show you.
 */
function readFacetSample(raw: string | null | undefined, into: { instances: Set<string>; repos: Set<string>; classes: Set<string>; dispositions: Set<string> }): void {
	if (!raw) return;
	let ctx: Record<string, unknown>;
	try {
		const v = JSON.parse(raw) as unknown;
		if (!v || typeof v !== "object" || Array.isArray(v)) return;
		ctx = v as Record<string, unknown>;
	} catch {
		return;
	}
	const str = (k: string): string | null => {
		const v = ctx[k];
		return typeof v === "string" && v.trim() ? v.trim() : null;
	};
	// `instance_id` as well as `instanceId`: the trace bridge in error-log.ts reads both, because
	// both spellings are written by real call sites.
	const instance = str("instanceId") ?? str("instance_id");
	if (instance) into.instances.add(instance);
	const repo = str("repo") ?? str("githubRepo");
	if (repo) into.repos.add(repo);
	const cls = str("failureClass");
	if (cls) into.classes.add(cls);
	const disposition = str("disposition");
	if (disposition) into.dispositions.add(disposition);
}

/** Group raw errors into signatures, sorted by count (desc) then most-recent. */
export function summarizeErrors(rows: RawError[]): ErrorSignature[] {
	const map = new Map<string, ErrorSignature>();
	const seenUsers = new Map<string, Set<string>>();
	const facetSets = new Map<string, { instances: Set<string>; repos: Set<string>; classes: Set<string>; dispositions: Set<string> }>();
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
				facets: { instances: [], repos: [], failureClasses: [], resumed: false, ended: false },
			};
			map.set(key, sig);
			seenUsers.set(key, new Set());
			facetSets.set(key, { instances: new Set(), repos: new Set(), classes: new Set(), dispositions: new Set() });
		}
		// BOTH retained samples, not just the first: #538 keeps the latest one precisely so a
		// collapsed bucket is not represented by whichever occurrence happened to open it.
		const facets = facetSets.get(key)!;
		readFacetSample(r.context, facets);
		readFacetSample(r.last_context, facets);
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
	for (const [key, sig] of map) {
		sig.users = seenUsers.get(key)!.size;
		const f = facetSets.get(key)!;
		// Sorted so the rendered order is a property of the data rather than of insertion — a list
		// that reshuffles between polls reads as a change nobody made.
		sig.facets = {
			instances: [...f.instances].sort(),
			repos: [...f.repos].sort(),
			failureClasses: [...f.classes].sort(),
			resumed: f.dispositions.has("resumed"),
			ended: f.dispositions.has("ended"),
		};
	}
	return [...map.values()].sort((a, b) => b.count - a.count || (a.lastSeen < b.lastSeen ? 1 : -1));
}
