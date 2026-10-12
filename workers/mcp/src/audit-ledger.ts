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
	/** True only once every legacy event still within retention has been indexed. */
	complete: boolean;
	retentionDays: number;
	legacyIndex: "complete" | "in_progress" | "not_started";
	detail: string;
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
	"Each event records an MCP tool call being dispatched, refused, dry-run or returned (`action`). " +
	"`completed` means the TOOL CALL returned — not that the engine turn, run, deploy or external task " +
	"it started has finished; follow the ids in `input`/`result` (instance_id, session_id, run/queue ids) " +
	"to that work's own record.";

export async function readAuditCoverage(kv: KVNamespace): Promise<AuditCoverage> {
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
