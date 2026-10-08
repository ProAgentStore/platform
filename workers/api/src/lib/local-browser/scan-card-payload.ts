/**
 * What a `local_browser.scan` board card carries (#980) — the shape alone, and how to read it back.
 *
 * A LEAF on purpose: it imports nothing, for the reason `applications/application-card-payload.ts`
 * is one. `lib/board.ts` is the GENERIC board and must pass this field through without acquiring a
 * dependency on the local-browser domain — whose own modules reach the runner, the store and the
 * trigger tables. The writer (`scan-board.ts`) and the reader (`board.ts`) share this definition
 * rather than one importing the other.
 *
 * Counts, ids and closed-vocabulary words only: the privacy boundary is argued in `telemetry.ts`,
 * and a board card is the widest surface this data reaches (the console, a supervisor's
 * `subordinate_status`, MCP's `instance_board`).
 */

/** What a `local_browser.scan` card carries, as the domain wrote it. */
export interface ScanCardPayload {
	runId: string;
	startedBy: "owner" | "trigger" | "unknown";
	pages: number;
	results: number;
	leadsAdded: number;
	duplicates: number;
	pendingReview: number;
	sourcesConfigured: number;
	sourcesUnreachable: number;
	handoffs: number;
	warnings: number;
	errors: number;
	outcome: string;
	/** The sentence that explains the scan — including why it found nothing. */
	reason: string;
	/** The Data records this scan produced (#980: leads stay Data, joined to their scan). */
	leadRecordIds: string[];
	pauseReason?: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Read the scan block off a card's payload, taking only what it declares.
 *
 * Validated rather than cast, like the application payload: a card written by a past release must
 * read as "not a scan card" instead of handing the console a half-built object — and `runId` is the
 * field everything else hangs off, so its absence is the test.
 */
export function parseScanCard(value: unknown): ScanCardPayload | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const o = value as Record<string, unknown>;
	const runId = str(o.runId).trim();
	if (!runId) return undefined;
	const startedBy = o.startedBy === "owner" || o.startedBy === "trigger" ? o.startedBy : "unknown";
	const ids = Array.isArray(o.leadRecordIds) ? o.leadRecordIds.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
	return {
		runId,
		startedBy,
		pages: num(o.pages),
		results: num(o.results),
		leadsAdded: num(o.leadsAdded),
		duplicates: num(o.duplicates),
		pendingReview: num(o.pendingReview),
		sourcesConfigured: num(o.sourcesConfigured),
		sourcesUnreachable: num(o.sourcesUnreachable),
		handoffs: num(o.handoffs),
		warnings: num(o.warnings),
		errors: num(o.errors),
		outcome: str(o.outcome),
		reason: str(o.reason),
		leadRecordIds: ids.slice(0, 50),
		...(str(o.pauseReason) ? { pauseReason: str(o.pauseReason) } : {}),
	};
}
