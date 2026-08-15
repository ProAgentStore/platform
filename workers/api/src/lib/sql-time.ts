/**
 * The one way to write a timestamp into a TEXT column D1 compares with `datetime('now')`.
 *
 * ## Why this file exists
 *
 * SQLite compares TEXT with BINARY collation. `' '` is `0x20` and `'T'` is `0x54`, so for two
 * stamps on the same date an ISO-8601 string sorts ABOVE every `datetime('now')` string no matter
 * what the clock said:
 *
 *   `'2026-08-15T00:00:01.000Z' > '2026-08-15 22:38:19'` → 1
 *
 * The two formats do not interleave. A column with one writer per format is therefore not "nearly
 * sorted" — it is two disjoint blocks, and any `ORDER BY … LIMIT` over it returns whichever block
 * won the byte comparison rather than the newest rows. Two shipped defects were exactly this:
 *
 *   • #634 — `instance_runtime_tasks.updated_at` had eleven `datetime('now')` writers and three
 *     ISO ones. `recentWorkForInstances` takes EIGHT cards per subordinate, so the escalation card
 *     that says "a supervised agent needs a decision" lost its slot to any runner-mirrored task
 *     stamped earlier the same day.
 *   • #657 — `mcp_input_requests.expires_at` (30 min) and `mcp_oauth_flows.expires_at` (10 min)
 *     were written ISO and purged with `expires_at <= datetime('now')`, a predicate that stays
 *     false for the whole UTC day the row expires on. Encrypted call arguments and a PKCE verifier
 *     outlived their stated retention by up to ~24 h.
 *
 * The same three lines had been copied privately into six files by the time the sweep found it
 * (`error-log.ts`, `admin.ts`, `admin-instance-detail.ts`, `external-usage.ts`, `runtime-response.ts`,
 * `coding-repos.ts`) — every one of them correct, and none of them reachable from the writers that
 * were wrong. A seventh copy is what this replaces.
 *
 * ## Why the type, and not a comment
 *
 * {@link SqlTime} is branded, so a plain `string` cannot be passed where one is required and the
 * only way to obtain one is {@link sqlTime} or {@link toSqlTime}. That is deliberate: the failure
 * this codebase keeps repeating is not a missing helper, it is a helper with a call site that does
 * not use it (#591 — `waiting_until` had one writer and three call sites, none of which passed the
 * value). A column whose writers all take `SqlTime` cannot acquire a fourth writer in the wrong
 * format without the compiler saying so.
 *
 * The brand stops at the `.bind()` call — D1 takes `unknown` — so the executable half of the
 * guard is `sql-time-writers.test.ts`, which drives every writer of the affected columns through
 * a real SQLite and asserts the stored bytes.
 */

/**
 * A timestamp in D1's own `datetime('now')` shape: `YYYY-MM-DD HH:MM:SS`, UTC, no zone, no
 * fractional seconds. Obtainable only from this module.
 */
export type SqlTime = string & { readonly __sqlTime: unique symbol };

/** Exactly what `datetime('now')` emits. Anchored at both ends: a longer ISO string must not pass. */
const SQL_TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Is this already in the column's format? Narrows, so a value read back from D1 can be re-used. */
export function isSqlTime(value: unknown): value is SqlTime {
	return typeof value === "string" && SQL_TIME_PATTERN.test(value);
}

/**
 * `at` in the shape D1 stores it. Defaults to now.
 *
 * Truncating to the second rather than rounding matches `datetime('now')`, which has no
 * sub-second component at all — so a row written here and a row written by SQL are comparable
 * byte-for-byte, which is the entire point.
 */
export function sqlTime(at: number | Date = Date.now()): SqlTime {
	const d = typeof at === "number" ? new Date(at) : at;
	return d.toISOString().slice(0, 19).replace("T", " ") as SqlTime;
}

/**
 * Normalise a timestamp of unknown provenance into the column's format.
 *
 * The boundary converter: a runner sends `updatedAt` as ISO (`packages/browser-runner`), a caller
 * may echo back a value it read out of D1, and either has to land in the column as one shape.
 * Anything unparseable falls back to `at` rather than being stored verbatim — an unsortable string
 * in a sorted column is worse than an approximate one, because the row silently leaves the window
 * a reader is looking at instead of being slightly wrong inside it.
 */
export function toSqlTime(value: unknown, at: number | Date = Date.now()): SqlTime {
	if (isSqlTime(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const ms = sqlTimeMs(value);
		if (Number.isFinite(ms)) return sqlTime(ms);
	}
	return sqlTime(at);
}

/**
 * Epoch milliseconds for a stored stamp, in EITHER format, always read as UTC.
 *
 * `Date.parse` is not a substitute. V8 parses `"2026-08-15 22:38:19"` — no `T`, no zone — as LOCAL
 * time, which is right in the Workers runtime (UTC) and wrong in a test process anywhere else. So
 * a column read back with `Date.parse` is correct in production and quietly hour-shifted in the
 * suite, which is the wrong way round for a bug to be visible. Returns `NaN` for anything it
 * cannot read, so a caller can decide rather than be handed a plausible number.
 */
export function sqlTimeMs(value: string): number {
	const trimmed = value.trim();
	if (!trimmed) return Number.NaN;
	return Date.parse(isSqlTime(trimmed) ? `${trimmed}Z` : trimmed);
}

/**
 * A stored stamp as ISO-8601, for a JSON field that has always published one.
 *
 * The column's format is an internal decision about how SQLite sorts it; a response body that
 * promised ISO keeps promising ISO. Unparseable input is returned untouched — a response is not
 * the place to invent a timestamp.
 */
export function sqlTimeToIso(value: string): string {
	const ms = sqlTimeMs(value);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}
