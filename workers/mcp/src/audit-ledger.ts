/**
 * The MCP audit ledger's key layout and its page reader (#1016).
 *
 * The first audit keys were `audit:{subject}:{ISO time}:{uuid}`. KV lists LEXICOGRAPHICALLY and
 * caps a list at 1000 keys, so a subject's listing started at its OLDEST event and the newest one
 * past the thousandth was unreachable: `mcp_audit_log` answered October with September (#704 step
 * 5). Sorting a bigger slice cannot fix that — any finite page of an ascending listing is the old
 * end of it.
 *
 * So the ledger is written under an INVERTED time: `MAX_MS - epoch ms`, zero-padded to 13 digits.
 * The lexicographic order KV already gives us is then newest-first, the first page IS the latest
 * window, and KV's own list cursor is the continuation — bounded reads at any volume, no scan.
 *
 *   audit_idx:{subject}:{inverted}:{uuid}   one owner's events (MCP tool + owner HTTP route)
 *   audit_all:{inverted}:{subject}:{uuid}   every owner's events by time (admin sweep only)
 *
 * Order is time descending, then event id ascending within one millisecond: stable, so a page
 * boundary can neither repeat nor skip an event. Both keys hold the same value and expire with
 * the event (90 days). Legacy `audit:` keys are copied in by the API Worker's bounded backfill
 * (`workers/api/src/lib/mcp-audit-ledger.ts`), which records its progress under
 * `AUDIT_MIGRATION_KEY`; a reader reports coverage from that record rather than implying the
 * history before the ledger existed is all there.
 *
 * A copy of the key layout lives in the API Worker's `lib/mcp-audit-ledger.ts` — a Worker does
 * not import across the Worker boundary — and both test suites assert the same key strings.
 * Dependency-free on purpose: `safety.ts` imports it, and other stores vendor `safety.ts`.
 */

export const AUDIT_TTL_SECONDS = 90 * 86_400;
export const AUDIT_INDEX_PREFIX = "audit_idx:";
export const AUDIT_GLOBAL_PREFIX = "audit_all:";
export const AUDIT_MIGRATION_KEY = "audit_ledger_migration";
/**
 * A PARTIAL index write — one of an event's two keys landed — is recorded here for the API Worker's
 * per-minute cron to finish (#1084), in the shape `workers/api/src/lib/telemetry-spool.ts` replays:
 * `{ sink, id, payload: { keys, value, expiration, metadata }, attempts, nextAt, createdAt }`.
 * Replay re-puts the same key with the same value and the same absolute expiry, so finishing it
 * twice changes nothing and an event never outlives its 90 days. Loss is counted per day under
 * `AUDIT_LOSS_PREFIX`. Both test suites assert these strings.
 */
export const AUDIT_SPOOL_PREFIX = "tel_spool:mcp_audit:";
export const AUDIT_LOSS_PREFIX = "tel_loss:mcp_audit:";
export const AUDIT_DEAD_PREFIX = "tel_dead:mcp_audit:";
/** Pending partial writes kept at once — the spool's per-sink capacity. */
export const AUDIT_SPOOL_MAX = 1000;
/** The spool's own TTL (7 days) and its first replay delay (5s). */
export const AUDIT_SPOOL_TTL_SECONDS = 7 * 86_400;
export const AUDIT_SPOOL_FIRST_DELAY_MS = 5_000;
/** 13 digits of epoch milliseconds — the year 2286. */
const MAX_MS = 9_999_999_999_999;

export function invertedTime(ms: number): string {
	return String(MAX_MS - ms).padStart(13, "0");
}

export function auditIndexKey(subject: string, ms: number, id: string): string {
	return `${AUDIT_INDEX_PREFIX}${subject}:${invertedTime(ms)}:${id}`;
}

export function auditGlobalKey(subject: string, ms: number, id: string): string {
	return `${AUDIT_GLOBAL_PREFIX}${invertedTime(ms)}:${subject}:${id}`;
}

/** Listing metadata, so a `tool` filter can skip non-matching keys without reading them. */
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
	/**
	 * True only when BOTH halves are: every legacy event within retention has been indexed
	 * (`migrationComplete`) and every recorded event reached both indexes (`delivery.complete`, #1084).
	 */
	complete: boolean;
	/** The legacy backfill alone — finished and nothing unplaceable. Says nothing about delivery. */
	migrationComplete: boolean;
	delivery: AuditDelivery;
	retentionDays: number;
	legacyIndex: "complete" | "in_progress" | "not_started";
	detail: string;
}
/**
 * Whether every event the MCP Worker ACCEPTED reached both indexes (#1084) — separate from whether
 * the legacy MIGRATION finished, which is all `legacyIndex` says. `pending` events landed in one index
 * and are spooled for the API cron to finish; `dead` exhausted their replays; `lost` (last 30 days)
 * could not even be spooled. `pendingCapped` means there are at least that many.
 */
export interface AuditDelivery {
	complete: boolean;
	pending: number;
	pendingCapped: boolean;
	dead: number;
	lost: number;
}


export interface AuditPage {
	events: Array<Record<string, unknown>>;
	count: number;
	/** Pass back as `cursor` for the next-older page. `null` = the end of the retained ledger. */
	nextCursor: string | null;
	coverage: AuditCoverage;
	/** What an event is a receipt OF — so a `completed` row is not read as the work being done. */
	semantics: string;
}

export const AUDIT_SEMANTICS =
	"Each event is ONE MCP tool call and how it ended (`action`): completed, dry_run, denied, failed (the tool " +
	"returned an error), error (the tool threw), invalid_input (rejected before it ran) or unknown (it could not " +
	"confirm its write). Anything but completed carries `failureClass`, `reason` and a plain `explanation`; " +
	"`gate: unverified` means the suspension check could not be made and the call was allowed. Successful " +
	"read-only calls are not recorded. `completed` means the TOOL CALL returned — not that the engine turn, run, " +
	"deploy or external task it started has finished; follow the ids in `input`/`result` (instance_id, " +
	"session_id, run/queue ids) to that work's own record.";

async function readMigrationCoverage(kv: KVNamespace): Promise<Omit<AuditCoverage, "migrationComplete" | "delivery">> {
	const raw = await kv.get(AUDIT_MIGRATION_KEY);
	const state = raw
		? (JSON.parse(raw) as { status?: string; pass?: number; scanned?: number; unplaceable?: number; passUnplaceable?: number })
		: null;
	const retentionDays = AUDIT_TTL_SECONDS / 86_400;
	// A record from the writer before ac253dd9 summed `unplaceable` over passes and never wrote
	// `passUnplaceable`: a total of observations, not records, which the API's backfill is
	// recounting (`needsRecount` in its copy). Partial until then, and no number is claimed.
	if (state && state.passUnplaceable === undefined && (state.unplaceable ?? 0) > 0) {
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
	const legacyIndex = state ? "in_progress" : "not_started";
	return {
		complete: false,
		retentionDays,
		legacyIndex,
		detail:
			"Events recorded before the time-ordered ledger existed are still being indexed" +
			(state ? ` (pass ${(state.pass ?? 0) + 1}, ${state.scanned ?? 0} legacy keys scanned so far)` : "") +
			". The newest events are complete; older pages may be missing legacy events until indexing finishes.",
	};
}

/** The delivery half: what the spool still holds, gave up on, or never got (the API's `telemetry-spool.ts`). */
async function readAuditDelivery(kv: KVNamespace): Promise<AuditDelivery> {
	const [pending, dead, losses] = await Promise.all([
		kv.list({ prefix: AUDIT_SPOOL_PREFIX, limit: AUDIT_SPOOL_MAX }),
		kv.list({ prefix: AUDIT_DEAD_PREFIX, limit: AUDIT_SPOOL_MAX }),
		kv.list({ prefix: AUDIT_LOSS_PREFIX, limit: 40 }),
	]);
	let lost = 0;
	for (const k of losses.keys) lost += Number((await kv.get(k.name)) ?? 0) || 0;
	const n = pending.keys.length;
	return { complete: n === 0 && dead.keys.length === 0 && lost === 0, pending: n, pendingCapped: !pending.list_complete || n >= AUDIT_SPOOL_MAX, dead: dead.keys.length, lost };
}

/**
 * Coverage of the ledger a reader is paging (#1016, #1084): the migration's half and the delivery
 * half, reported apart, `complete` only when both are. A storage failure throws — partial coverage
 * is never reported as whole because the spool could not be read.
 */
export async function readAuditCoverage(kv: KVNamespace): Promise<AuditCoverage> {
	const [migration, delivery] = await Promise.all([readMigrationCoverage(kv), readAuditDelivery(kv)]);
	const complete = migration.complete && delivery.complete;
	const gaps = [
		delivery.pending ? `${delivery.pending}${delivery.pendingCapped ? "+" : ""} recent event${delivery.pending === 1 ? " is" : "s are"} in only one index and waiting to be re-written to the other` : "",
		delivery.dead ? `${delivery.dead} could not be re-written after repeated attempts` : "",
		delivery.lost ? `${delivery.lost} audit write${delivery.lost === 1 ? "" : "s"} in the last 30 days could not be recorded at all` : "",
	].filter(Boolean);
	const detail = gaps.length
		? `${migration.complete ? "Legacy indexing finished. " : `${migration.detail} `}Delivery is incomplete: ${gaps.join("; ")}.`
		: migration.detail;
	return { ...migration, complete, migrationComplete: migration.complete, delivery, detail };
}

/**
 * Exact correlation (#1016): the event IS the receipt (its own `id`), or its `input`/`result` holds
 * that id as a whole string value at any depth — a run, queue entry, session, task or request id
 * the tool call returned or acted on. Whole-value equality, never a substring: `run_1` must not
 * match `run_10`.
 */
export function carriesReceipt(event: Record<string, unknown>, receipt: string): boolean {
	if (event.id === receipt) return true;
	const holds = (value: unknown, depth: number): boolean => {
		if (value === receipt) return true;
		if (depth > 8 || !value || typeof value !== "object") return false;
		return Object.values(value).some((item) => holds(item, depth + 1));
	};
	return holds(event.input, 0) || holds(event.result, 0);
}

/**
 * One page of the ledger under `prefix`, newest first. A storage failure THROWS — the caller must
 * report it, never return the events it did get as though they were the whole page. A key that
 * lists but no longer reads expired or was deleted between the two calls; it is genuinely gone.
 */
export async function readAuditPage(
	kv: KVNamespace,
	{ prefix, limit, cursor, tool, receipt, requestId, mcpSessionId }: { prefix: string; limit: number; cursor?: string; tool?: string; receipt?: string; requestId?: string; mcpSessionId?: string },
): Promise<AuditPage> {
	const [listed, coverage] = await Promise.all([
		kv.list<AuditKeyMetadata>({ prefix, limit, ...(cursor ? { cursor } : {}) }),
		readAuditCoverage(kv),
	]);
	// A key with no metadata is read and filtered by its value instead of being dropped unseen.
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
	const events = loaded.filter(
		(e): e is Record<string, unknown> =>
			e !== null &&
			(!tool || e.tool === tool) &&
			(!receipt || carriesReceipt(e, receipt)) &&
			// The MCP request that wrote it (#1038) — exact; a request id repeats across sessions.
			(!requestId || e.requestId === requestId) &&
			(!mcpSessionId || e.mcpSessionId === mcpSessionId),
	);
	return {
		events,
		count: events.length,
		nextCursor: listed.list_complete ? null : (listed.cursor ?? null),
		coverage,
		semantics: AUDIT_SEMANTICS,
	};
}
