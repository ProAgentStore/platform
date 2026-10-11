/**
 * The MCP audit ledger, read and migrated from the API Worker (#1016).
 *
 * The MCP Worker WRITES the ledger (`workers/mcp/src/safety.ts`) into the `OAUTH_KV` namespace
 * both Workers bind. This module is the API side: the owner and admin read paths, and the bounded
 * backfill that copies the legacy `audit:{subject}:{ISO}:{uuid}` keys into it.
 *
 * WHY THE LAYOUT: KV lists lexicographically and at most 1000 keys per call. The legacy key sorts
 * ascending in time, so every reader started at a subject's OLDEST event and anything past the
 * thousandth was unreachable (#704 step 5). The ledger key carries an INVERTED time instead, so
 * KV's own order is newest-first and KV's own list cursor is the continuation:
 *
 *   audit_idx:{subject}:{inverted}:{uuid}   one owner's events
 *   audit_all:{inverted}:{subject}:{uuid}   every owner's events by time (admin sweep)
 *
 * Order: time descending, then event id ascending within one millisecond — stable, so pages
 * neither repeat nor skip. The key layout is a COPY of `workers/mcp/src/audit-ledger.ts` (a Worker
 * cannot import across the boundary); both test suites assert the same key strings.
 *
 * MIGRATION: legacy keys are never deleted — they expire on their own TTL. The backfill copies
 * each one into both indexes with the SAME absolute expiration, one bounded batch per cron tick,
 * resuming from a cursor stored under `AUDIT_MIGRATION_KEY`. Copies are idempotent (same key, same
 * value), so a failed or repeated batch is simply redone. It makes TWO full passes: an MCP isolate
 * still running the old writer during a deploy can add a legacy key behind the first pass's
 * cursor, and the second pass collects it. Until both finish, every read reports
 * `coverage.complete: false`.
 */

export const AUDIT_TTL_SECONDS = 90 * 86_400;
export const AUDIT_INDEX_PREFIX = "audit_idx:";
export const AUDIT_GLOBAL_PREFIX = "audit_all:";
export const AUDIT_LEGACY_PREFIX = "audit:";
export const AUDIT_MIGRATION_KEY = "audit_ledger_migration";
/** 13 digits of epoch milliseconds — the year 2286. */
const MAX_MS = 9_999_999_999_999;
/** Legacy keys copied per cron tick: 1 get + 2 puts each keeps a tick near 300 KV operations. */
export const BACKFILL_BATCH = 100;
const BACKFILL_PASSES = 2;
/** KV refuses an absolute expiration less than 60 seconds away. */
const MIN_EXPIRATION_AHEAD_S = 60;

export function invertedTime(ms: number): string {
	return String(MAX_MS - ms).padStart(13, "0");
}

export function auditIndexKey(subject: string, ms: number, id: string): string {
	return `${AUDIT_INDEX_PREFIX}${subject}:${invertedTime(ms)}:${id}`;
}

export function auditGlobalKey(subject: string, ms: number, id: string): string {
	return `${AUDIT_GLOBAL_PREFIX}${invertedTime(ms)}:${subject}:${id}`;
}

export interface AuditKeyMetadata {
	tool?: string;
	action?: string;
}

export function auditKeyMetadata(event: Record<string, unknown>): AuditKeyMetadata {
	const meta: AuditKeyMetadata = {};
	if (typeof event.tool === "string" && event.tool.length <= 100) meta.tool = event.tool;
	if (typeof event.action === "string" && event.action.length <= 100) meta.action = event.action;
	return meta;
}

export interface AuditCoverage {
	/** True only once every legacy event still within retention has been indexed. */
	complete: boolean;
	retentionDays: number;
	legacyIndex: "complete" | "in_progress" | "not_started";
	detail: string;
}

export interface AuditMigrationState {
	status: "running" | "complete";
	/** Completed full passes over the legacy keys. */
	pass: number;
	cursor?: string;
	scanned: number;
	copied: number;
	/** Listed but gone, or too close to expiry to copy — expired either way. */
	expired: number;
	/**
	 * DISTINCT legacy records that could not be placed (unparseable, or no subject/time/id) — the
	 * count from the latest COMPLETED pass. Each pass lists every key once, so a per-pass count is a
	 * count of records; summing passes counted each one twice. Never indexed, so coverage is partial.
	 */
	unplaceable: number;
	/** The current pass's running count; it becomes `unplaceable` when the pass completes. */
	passUnplaceable?: number;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
}

export const AUDIT_SEMANTICS =
	"Each event records an MCP tool call being dispatched, refused, dry-run or returned (`action`). " +
	"`completed` means the TOOL CALL returned — not that the engine turn, run, deploy or external task " +
	"it started has finished; follow the ids in `input`/`result` (instance_id, session_id, run/queue ids) " +
	"to that work's own record.";

async function readMigrationState(kv: KVNamespace): Promise<AuditMigrationState | null> {
	const raw = await kv.get(AUDIT_MIGRATION_KEY);
	return raw ? (JSON.parse(raw) as AuditMigrationState) : null;
}

/**
 * A record from the writer before ac253dd9, which ADDED each pass's unplaceable count to
 * `unplaceable` and never wrote `passUnplaceable`. (This writer always writes it at a pass end, and
 * leaves `unplaceable` at 0 until then, so a nonzero `unplaceable` with no `passUnplaceable` is
 * only that writer's.) Its number totals observations, not records. Part of it may also be for keys
 * behind the cursor, which the current pass will not see again. It is neither a distinct count nor
 * safe to drop, so the backfill recounts and every reader reports partial coverage until then.
 */
export function needsRecount(state: Pick<AuditMigrationState, "unplaceable" | "passUnplaceable">): boolean {
	return state.passUnplaceable === undefined && (state.unplaceable ?? 0) > 0;
}

export async function readAuditCoverage(kv: KVNamespace): Promise<AuditCoverage> {
	const state = await readMigrationState(kv);
	const retentionDays = AUDIT_TTL_SECONDS / 86_400;
	if (state && needsRecount(state)) {
		return {
			complete: false,
			retentionDays,
			legacyIndex: "in_progress",
			detail:
				"Some legacy records could not be indexed, and their count is being re-established: an earlier indexer counted them once per pass, so its total is not a number of records. Older pages may be missing legacy events until the recount finishes.",
		};
	}
	if (state?.status === "complete") {
		// Finished is not the same as whole: a legacy record with no parseable subject, time or id was
		// never indexed, so the history is partial by exactly that many records and must say so.
		if ((state.unplaceable ?? 0) > 0) {
			const n = state.unplaceable ?? 0;
			return {
				complete: false,
				retentionDays,
				legacyIndex: "complete",
				detail: `Indexing finished, but ${n} unplaceable legacy record${n === 1 ? "" : "s"} could not be indexed (unparseable, or missing a subject or time); they are not in this history.`,
			};
		}
		return { complete: true, retentionDays, legacyIndex: "complete", detail: `Every event from the last ${retentionDays} days is indexed; older events have expired.` };
	}
	return {
		complete: false,
		retentionDays,
		legacyIndex: state ? "in_progress" : "not_started",
		detail:
			"Events recorded before the time-ordered ledger existed are still being indexed" +
			(state ? ` (pass ${state.pass + 1}, ${state.scanned} legacy keys scanned so far)` : "") +
			". The newest events are complete; older pages may be missing legacy events until indexing finishes.",
	};
}

export interface AuditPage<E = Record<string, unknown>> {
	events: E[];
	count: number;
	/** Pass back as `cursor` for the next-older page. `null` = the end of the retained ledger. */
	nextCursor: string | null;
	coverage: AuditCoverage;
	semantics: string;
}

/**
 * One page under `prefix`, newest first. A storage failure THROWS — never a short page passed off
 * as the whole one. A key that lists but no longer reads expired or was deleted between the two
 * calls, and is genuinely gone. A `tool` filter is applied from listing metadata, so a filtered
 * page can hold fewer than `limit` events (even none) while `nextCursor` still continues.
 */
export async function readAuditPage(
	kv: KVNamespace,
	{ prefix, limit, cursor, tool }: { prefix: string; limit: number; cursor?: string; tool?: string },
): Promise<AuditPage> {
	const [listed, coverage] = await Promise.all([
		kv.list<AuditKeyMetadata>({ prefix, limit, ...(cursor ? { cursor } : {}) }),
		readAuditCoverage(kv),
	]);
	const wanted = tool ? listed.keys.filter((k) => !k.metadata?.tool || k.metadata.tool === tool) : listed.keys;
	const loaded = await Promise.all(
		wanted.map(async (key) => {
			const raw = await kv.get(key.name);
			if (raw === null) return null;
			try {
				return JSON.parse(raw) as Record<string, unknown>;
			} catch {
				// Still a record that exists — shown raw rather than silently skipped.
				return { id: key.name.slice(key.name.lastIndexOf(":") + 1), raw };
			}
		}),
	);
	const events = loaded.filter((e): e is Record<string, unknown> => e !== null && (!tool || e.tool === tool));
	return {
		events,
		count: events.length,
		nextCursor: listed.list_complete ? null : (listed.cursor ?? null),
		coverage,
		semantics: AUDIT_SEMANTICS,
	};
}

/**
 * Place one legacy key: its subject, time and id. The stored value carries `subject` and `time`;
 * the name is the fallback (`audit:{subject}:{ISO}:{uuid}` — the ISO part holds colons, so the
 * subject is the segment before the first one and the id the segment after the last).
 */
function placeLegacy(name: string, event: Record<string, unknown>): { subject: string; ms: number; id: string } | null {
	const rest = name.slice(AUDIT_LEGACY_PREFIX.length);
	const id = rest.slice(rest.lastIndexOf(":") + 1);
	const subject = typeof event.subject === "string" && event.subject ? event.subject : rest.slice(0, rest.indexOf(":"));
	const ms = Date.parse(typeof event.time === "string" ? event.time : rest.slice(rest.indexOf(":") + 1, rest.lastIndexOf(":")));
	if (!subject || !id || Number.isNaN(ms)) return null;
	return { subject, ms, id };
}

/**
 * One bounded backfill step: copy up to `batch` legacy keys into the ledger and advance the stored
 * cursor. Idempotent and resumable — the cursor only moves after the whole batch landed, so a
 * failure redoes the same batch on the next tick. Never deletes a legacy key.
 */
export async function runAuditLedgerBackfill(
	kv: KVNamespace,
	{ now = Date.now(), batch = BACKFILL_BATCH }: { now?: number; batch?: number } = {},
): Promise<AuditMigrationState> {
	const nowIso = new Date(now).toISOString();
	const state: AuditMigrationState = (await readMigrationState(kv)) ?? {
		status: "running",
		pass: 0,
		scanned: 0,
		copied: 0,
		expired: 0,
		unplaceable: 0,
		startedAt: nowIso,
		updatedAt: nowIso,
	};
	if (needsRecount(state)) {
		// Restart the last pass from its beginning: a pass sees every key once, so its count is
		// distinct. Copies are idempotent, so the repeat costs operations, never duplicates.
		state.status = "running";
		state.pass = Math.min(state.pass, BACKFILL_PASSES - 1);
		state.cursor = undefined;
		state.passUnplaceable = 0;
		state.completedAt = undefined;
	}
	if (state.status === "complete") return state;

	const listed = await kv.list({ prefix: AUDIT_LEGACY_PREFIX, limit: batch, ...(state.cursor ? { cursor: state.cursor } : {}) });
	const nowS = Math.floor(now / 1000);
	const outcomes = await Promise.all(
		listed.keys.map(async (key): Promise<"copied" | "expired" | "unplaceable"> => {
			const raw = await kv.get(key.name);
			if (raw === null) return "expired";
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(raw) as Record<string, unknown>;
			} catch {
				return "unplaceable";
			}
			const placed = placeLegacy(key.name, event);
			if (!placed) return "unplaceable";
			// Keep the event's own expiry: an index copy must not outlive the record it copies.
			const expiration = key.expiration ?? Math.floor(placed.ms / 1000) + AUDIT_TTL_SECONDS;
			if (expiration < nowS + MIN_EXPIRATION_AHEAD_S) return "expired";
			const value = JSON.stringify({ ...event, id: placed.id, time: new Date(placed.ms).toISOString(), subject: placed.subject });
			const options = { expiration, metadata: auditKeyMetadata(event) };
			await Promise.all([
				kv.put(auditIndexKey(placed.subject, placed.ms, placed.id), value, options),
				kv.put(auditGlobalKey(placed.subject, placed.ms, placed.id), value, options),
			]);
			return "copied";
		}),
	);

	state.scanned += outcomes.length;
	for (const o of outcomes) {
		if (o === "unplaceable") state.passUnplaceable = (state.passUnplaceable ?? 0) + 1;
		else state[o] += 1;
	}
	state.updatedAt = nowIso;
	if (listed.list_complete) {
		state.cursor = undefined;
		// The pass saw every key once: its count is the distinct count. Replace, never add.
		state.unplaceable = state.passUnplaceable ?? 0;
		state.passUnplaceable = 0;
		state.pass += 1;
		if (state.pass >= BACKFILL_PASSES) {
			state.status = "complete";
			state.completedAt = nowIso;
		}
	} else {
		state.cursor = listed.cursor;
	}
	await kv.put(AUDIT_MIGRATION_KEY, JSON.stringify(state));
	return state;
}
