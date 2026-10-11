/**
 * The MCP audit ledger: newest-first, cursor-paged, with an explicit legacy coverage (#1016).
 *
 * ── Why the old reads went stale
 *
 * Events were keyed `audit:{subject}:{ISO time}:{uuid}`, which sorts ASCENDING in time, and KV lists
 * lexicographically 1000 names at a time. Every reader listed ONE page and sorted it, so past 1000
 * events per account the "newest" window was the newest of the OLDEST 1000 — a month stale, with no
 * cursor and no sign anything was missing (#704 step 5 deferred exactly this).
 *
 * ── The ledger
 *
 *     auditd:{subject}:{inverted ms, 13 digits}:{id}
 *
 * The inverted timestamp makes KV's own lexicographic order newest-first, and KV's own cursor makes
 * pagination real and bounded: one `list` and at most `MAX_LOADS` `get`s per page, whatever the
 * account's volume. Ties within a millisecond order by `id`, so the order is total and stable.
 * Tenant isolation stays structural — the prefix is built from the caller's uid, never a parameter.
 *
 * The MCP worker writes this key (`workers/mcp/src/safety.ts` `ledgerKey`, a deliberate copy —
 * the workers cannot import each other; `mcp-audit-ledger.test.ts` asserts the two agree).
 *
 * ── Legacy events
 *
 * Events written before the ledger stay where they are: nothing is deleted. `backfillLegacyAudit`
 * (the per-minute cron) copies each still-retained legacy event to its ledger key, bounded per tick,
 * resumable from a stored cursor, and idempotent — the ledger key is derived from the legacy key, so
 * a retried page rewrites the same keys. The copy keeps the legacy key's ORIGINAL absolute expiry, so
 * retention is never extended. Until it has passed an account, that account's reads report
 * `coverage.complete: false` — a partial history never presents as a complete one.
 */

export const LEDGER_PREFIX = "auditd:";
export const LEGACY_PREFIX = "audit:";
/** Backfill progress — global, because legacy keys are ordered by subject and swept in one pass. */
export const MIGRATION_KEY = "auditmig:v1";
/** The retention every audit write has used (`expirationTtl: 90 * 86_400`). */
export const AUDIT_RETENTION_MS = 90 * 86_400_000;
const INVERT_BASE = 9_999_999_999_999;
/** KV refuses an absolute expiry less than 60s ahead; a legacy event that close to expiry is left to lapse. */
const MIN_EXPIRY_HEADROOM_S = 60;

export function invertedMs(ms: number): string {
	return String(INVERT_BASE - ms).padStart(13, "0");
}

export function ledgerKey(subject: string, isoTime: string, id: string): string {
	return `${LEDGER_PREFIX}${subject}:${invertedMs(Date.parse(isoTime))}:${id}`;
}

/** A legacy `audit:{subject}:{ISO}:{uuid}` name, parsed. Subjects may contain `:` (`google:1107…`). */
export function parseLegacyKey(name: string): { subject: string; time: string; id: string } | null {
	if (!name.startsWith(LEGACY_PREFIX)) return null;
	const m = /^audit:(.+):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z):([^:]+)$/.exec(name);
	if (!m || Number.isNaN(Date.parse(m[2]))) return null;
	return { subject: m[1], time: m[2], id: m[3] };
}

export interface MigrationState {
	cursor: string | null;
	/** The last legacy key name a completed page reached — what per-account coverage is read from. */
	lastKey: string | null;
	done: boolean;
	copied: number;
	skippedExpired: number;
	updatedAt: number;
}

async function readState(kv: KVNamespace): Promise<MigrationState | null> {
	const raw = await kv.get(MIGRATION_KEY);
	return raw ? (JSON.parse(raw) as MigrationState) : null;
}

/**
 * Copy one bounded page of legacy events to the ledger. Never deletes; never extends retention.
 *
 * The cursor is saved only AFTER the page is fully copied, so a tick that dies mid-page repeats that
 * page next time — harmless, because every copy targets the same derived key with the same value.
 */
export async function backfillLegacyAudit(kv: KVNamespace, opts: { pageSize?: number; now?: number } = {}): Promise<MigrationState> {
	const now = opts.now ?? Date.now();
	const state: MigrationState = (await readState(kv)) ?? { cursor: null, lastKey: null, done: false, copied: 0, skippedExpired: 0, updatedAt: now };
	if (state.done) return state;
	const page = await kv.list({ prefix: LEGACY_PREFIX, limit: opts.pageSize ?? 250, ...(state.cursor ? { cursor: state.cursor } : {}) });
	for (const key of page.keys) {
		const parsed = parseLegacyKey(key.name);
		if (!parsed) continue;
		// The ORIGINAL expiry: the key's own when KV reports it, else the write-time rule.
		const expiresAtS = key.expiration ?? Math.floor((Date.parse(parsed.time) + AUDIT_RETENTION_MS) / 1000);
		if (expiresAtS - Math.floor(now / 1000) < MIN_EXPIRY_HEADROOM_S) {
			state.skippedExpired++;
			continue;
		}
		const raw = await kv.get(key.name);
		if (raw === null) {
			state.skippedExpired++;
			continue;
		}
		let value: Record<string, unknown>;
		try {
			value = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			value = { raw };
		}
		await kv.put(ledgerKey(parsed.subject, parsed.time, parsed.id), JSON.stringify({ ...value, id: parsed.id, time: value.time ?? parsed.time, subject: value.subject ?? parsed.subject, legacy: true }), {
			expiration: expiresAtS,
		});
		state.copied++;
	}
	if (page.keys.length) state.lastKey = page.keys[page.keys.length - 1].name;
	state.done = page.list_complete;
	state.cursor = page.list_complete ? null : ((page as { cursor?: string }).cursor ?? null);
	state.updatedAt = now;
	await kv.put(MIGRATION_KEY, JSON.stringify(state));
	return state;
}

export type LegacyCoverage =
	| { state: "complete"; note: string }
	| { state: "in_progress" | "not_started"; note: string; updatedAt: number | null }
	| { state: "unavailable"; note: string };

/** How much of THIS account's pre-ledger history the ledger already holds. */
export async function legacyCoverage(kv: KVNamespace, subject: string): Promise<LegacyCoverage> {
	let state: MigrationState | null;
	try {
		state = await readState(kv);
	} catch {
		return { state: "unavailable", note: "The legacy backfill state could not be read; older events may be missing from these pages." };
	}
	// Legacy names order by subject first, so a sweep past `audit:{subject};` (`;` follows `:`) has
	// passed every key of this account.
	if (state?.done || (state?.lastKey && state.lastKey >= `${LEGACY_PREFIX}${subject};`)) {
		return { state: "complete", note: "Every retained pre-ledger event of this account is in the ledger." };
	}
	return state
		? { state: "in_progress", note: "Older events written before the ledger are still being copied in; pages may be missing them.", updatedAt: state.updatedAt }
		: { state: "not_started", note: "Older events written before the ledger have not been copied in yet; pages may be missing them.", updatedAt: null };
}

export interface LedgerFilter {
	tool?: string;
	action?: string;
	/** Exact match against the event's `input` — the joins to session/run/request/queue receipts. */
	sessionId?: string;
	runId?: string;
	requestId?: string;
	entryId?: string;
}

/** At most this many values are loaded per page, filtered or not. */
export const MAX_LOADS = 200;
const LIST_PAGE = 1000;

interface Cursor {
	/** The KV cursor the current list page started from (null = the first page). */
	c: string | null;
	/** The last key name already scanned on that page. */
	a: string | null;
}

export function encodeCursor(cur: Cursor): string {
	return btoa(JSON.stringify(cur)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(raw: string | undefined | null): Cursor | null | "invalid" {
	if (!raw) return null;
	try {
		const json = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
		const v = JSON.parse(json) as Cursor;
		if ((v.c !== null && typeof v.c !== "string") || (v.a !== null && typeof v.a !== "string")) return "invalid";
		return v;
	} catch {
		return "invalid";
	}
}

function inputOf(e: Record<string, unknown>): Record<string, unknown> {
	return e.input && typeof e.input === "object" ? (e.input as Record<string, unknown>) : {};
}

function matches(e: Record<string, unknown>, f: LedgerFilter): boolean {
	if (f.tool && e.tool !== f.tool) return false;
	if (f.action && e.action !== f.action) return false;
	const input = inputOf(e);
	const pick = (...names: string[]) => names.map((n) => input[n]).find((v) => typeof v === "string");
	if (f.sessionId && pick("session_id", "sessionId") !== f.sessionId) return false;
	if (f.runId && pick("run_id", "runId") !== f.runId) return false;
	if (f.requestId && pick("request_id", "requestId") !== f.requestId) return false;
	if (f.entryId && pick("entry_id", "entryId", "id") !== f.entryId) return false;
	return true;
}

export interface LedgerPage {
	events: Array<Record<string, unknown>>;
	nextCursor: string | null;
	/** How many keys this page looked at — a filtered page may scan many and match few. */
	scanned: number;
	/** Values that could not be read on this page. Non-zero means the page is NOT complete. */
	unreadable: number;
}

/**
 * One page of an account's events, newest first. Bounded: one `list` and at most `MAX_LOADS` reads.
 * A value that expired between `list` and `get` is simply gone; a value that FAILED to read is
 * counted in `unreadable`, so the page says it is partial rather than looking whole.
 */
export async function readLedgerPage(kv: KVNamespace, input: { subject: string; limit: number; cursor: Cursor | null; filter?: LedgerFilter }): Promise<LedgerPage> {
	const limit = Math.max(1, Math.min(MAX_LOADS, input.limit));
	const filter = input.filter ?? {};
	const start = input.cursor ?? { c: null, a: null };
	const listed = await kv.list({ prefix: `${LEDGER_PREFIX}${input.subject}:`, limit: LIST_PAGE, ...(start.c ? { cursor: start.c } : {}) });
	const names = listed.keys.map((k) => k.name).filter((n) => !start.a || n > start.a);
	const events: Array<Record<string, unknown>> = [];
	let scanned = 0;
	let unreadable = 0;
	let last: string | null = null;
	for (const name of names) {
		if (events.length >= limit || scanned >= MAX_LOADS) break;
		scanned++;
		last = name;
		let raw: string | null;
		try {
			raw = await kv.get(name);
		} catch {
			unreadable++;
			continue;
		}
		if (raw === null) continue;
		let e: Record<string, unknown>;
		try {
			e = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			e = { raw };
		}
		const id = name.slice(name.lastIndexOf(":") + 1);
		const event = { ...e, id };
		if (matches(event, filter)) events.push(event);
	}
	const pageExhausted = last === null || last === names[names.length - 1];
	const listCursor = (listed as { cursor?: string }).cursor ?? null;
	const nextCursor = pageExhausted ? (listed.list_complete ? null : encodeCursor({ c: listCursor, a: null })) : encodeCursor({ c: start.c, a: last });
	return { events, nextCursor, scanned, unreadable };
}

/** What an event IS, stated beside every page so `action: "completed"` is not over-read. */
export const AUDIT_SEMANTICS =
	"Each event records an MCP tool CALL: dispatched, denied, previewed (dry_run) or completed. A completed call is not proof that the engine run, queued objective or external task it started has finished — follow its session_id / run_id / request_id to that receipt.";
