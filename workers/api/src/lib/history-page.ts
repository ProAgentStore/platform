import type { Env } from "../types.js";
import { telemetryDelivery, type TelemetrySink } from "./telemetry-spool.js";

/**
 * Stable traversal of the retained history logs (#1090): the trace (`agent_events`), the error log
 * and the admin-action audit.
 *
 * ## Why a keyset cursor, and on which column
 *
 * The old readers paged by OFFSET over "the newest N", so every insert during a walk shifted the
 * window: the row at the boundary came back twice, or a row slid past and was never shown — and
 * the trace could not reach past its newest 1000 events at all. A keyset cursor names the last row
 * the caller was given, `(key, id)`, and the next page is everything strictly OLDER than it, so a
 * row written mid-walk is newer than the walk's start and can never land inside it.
 *
 * The key must be IMMUTABLE for that to hold. `error_log`'s recency (`last_seen_at`) moves every
 * time a repeat folds into a row, which would carry an unread row past the cursor; its walk is
 * therefore ordered by `created_at` (first seen), which never changes, and the row's current
 * `repeat_count`/`last_seen_at` are whatever they were when the page was read.
 *
 * The cursor is opaque to callers: base64url JSON `[key, id]`, decoded and type-checked here.
 */
export type HistoryKey = string | number;

/** What a `?cursor=` query asks for: the newest page, an exact position, or nonsense. */
export type CursorQuery = { kind: "newest" } | { kind: "after"; key: HistoryKey; id: string } | { kind: "invalid" };

export const NEWEST_CURSOR = "newest";

export function encodeHistoryCursor(key: HistoryKey, id: string): string {
	const bytes = new TextEncoder().encode(JSON.stringify([key, id]));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeHistoryCursor(value: string): unknown {
	const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
	return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0))));
}

export function parseHistoryCursor(raw: string, keyType: "number" | "string"): CursorQuery {
	const value = raw.trim();
	if (!value || value === NEWEST_CURSOR) return { kind: "newest" };
	try {
		const decoded = decodeHistoryCursor(value);
		if (Array.isArray(decoded) && decoded.length === 2 && typeof decoded[0] === keyType && typeof decoded[1] === "string") {
			return { kind: "after", key: decoded[0] as HistoryKey, id: decoded[1] };
		}
	} catch {
		// fall through — a cursor nobody can parse is refused, never read as "start over"
	}
	return { kind: "invalid" };
}

/**
 * The keyset predicate for a newest-first walk, appended to `where`/`binds`. `keyExpr` and the id
 * column are trusted SQL from the caller, never input.
 */
export function keysetBefore(cursor: CursorQuery, keyExpr: string, where: string[], binds: unknown[]): void {
	if (cursor.kind !== "after") return;
	binds.push(cursor.key);
	const k = binds.length;
	binds.push(cursor.id);
	where.push(`(${keyExpr} < ?${k} OR (${keyExpr} = ?${k} AND id < ?${binds.length}))`);
}

/** A page of rows read one past `limit`, turned into rows + continuation. */
export function keysetPage<Row extends { id: string }>(rows: Row[], limit: number, keyOf: (row: Row) => HistoryKey) {
	const page = rows.slice(0, limit);
	const hasMore = rows.length > limit;
	const last = page[page.length - 1];
	return { rows: page, hasMore, nextCursor: hasMore && last ? encodeHistoryCursor(keyOf(last), last.id) : null };
}

/** `?since=` / `?until=` as an ISO time or epoch ms; `undefined` when absent, `null` when unparseable. */
export function parseTimeBound(raw: string | undefined): number | undefined | null {
	if (raw === undefined || raw.trim() === "") return undefined;
	const n = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Date.parse(raw.trim());
	return Number.isFinite(n) ? n : null;
}

/** SQLite `datetime()` text for an epoch — the shape `created_at` columns hold. */
export function sqlTimeOf(ms: number): string {
	return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

/** Declared retention per store. Restated, not changed, by #1090 (#1083: "do not silently change it"). */
export const RETENTION = {
	error_log: { days: 30, rule: "a row is pruned 30 days after it was last seen (opportunistic, on write)" },
	agent_events: { days: 14, rule: "an event is pruned 14 days after it was written (opportunistic, ~1% of writes)" },
	admin_audit_log: { days: null, rule: "no automatic expiry" },
} as const;

/**
 * What a reader must say beside a page so an empty or short answer is not mistaken for "nothing
 * happened": the retention horizon, the end-of-walk meaning, and — for an admin, because the
 * numbers are platform-wide (#1084) — the sink's replay backlog. A row waiting in that backlog is
 * written later WITH ITS ORIGINAL TIME, so it can land behind a cursor already passed; that is the
 * one way a completed walk can miss a row, and it is stated rather than hidden.
 */
export async function historyCoverage(env: Env, sink: TelemetrySink & keyof typeof RETENTION, admin: boolean, now = Date.now()) {
	const retention = RETENTION[sink];
	const coverage: Record<string, unknown> = {
		retention: {
			days: retention.days,
			rule: retention.rule,
			...(retention.days ? { horizon: new Date(now - retention.days * 86_400_000).toISOString() } : {}),
		},
		walk:
			"Newest first. Rows written after the walk's first page are not in it (start again from cursor \"newest\" to see them). " +
			"A row the primary store refused waits in the replay spool and is written later with its original time, so it can land behind a cursor already passed.",
	};
	if (!admin) {
		coverage.delivery = { visible: false, reason: "Replay backlog is platform-wide; admins read it here and in telemetry_health." };
		return coverage;
	}
	try {
		const { sinks } = await telemetryDelivery(env, now, [sink]);
		coverage.delivery = sinks[0] ?? null;
	} catch (e) {
		coverage.delivery = { error: `replay backlog could not be read: ${e instanceof Error ? e.message : String(e)}` };
	}
	return coverage;
}
