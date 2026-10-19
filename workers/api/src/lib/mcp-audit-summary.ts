/**
 * Per-tool counts of the MCP audit ledger (#1241), for the tool-surface audit: which tools are called,
 * and which fail — without reading a single event.
 *
 * Every ledger key carries `{ tool, action }` as KV listing metadata (#1016), and its name encodes the
 * event time, so a whole window is tallied from LIST calls alone (1,000 keys each), never one read per
 * event. A request walks at most {@link SUMMARY_MAX_KEYS} keys; past that the reply says where it got to
 * and hands back a cursor, and the caller adds the next page's counts to its own.
 *
 * What it cannot count: a successful READ-ONLY call is never written to the ledger (#1089), so a
 * read tool's `completed` is always 0 here and its failure share is over failures, not calls.
 */
import { type AuditKeyMetadata, keyTime } from "./mcp-audit-ledger.js";

/** Keys one summary request walks, at most: 20 list calls. */
export const SUMMARY_MAX_KEYS = 20_000;
/** Actions that mean the call did not do its job. */
const FAILING = ["invalid_input", "failed", "error"] as const;

export interface ToolSummary {
	tool: string;
	total: number;
	byAction: Record<string, number>;
	/** invalid_input + failed + error. */
	failures: number;
}

export interface AuditSummary {
	summary: true;
	scanned: number;
	window: { newest: string | null; oldest: string | null; since: string | null; until: string | null };
	tools: ToolSummary[];
	/** Continue the walk with this; null when the window (or the ledger) is exhausted. */
	nextCursor: string | null;
	complete: boolean;
	note: string;
}

export async function summarizeAuditLedger(
	kv: KVNamespace,
	q: { prefix: string; since?: number; until?: number; cursor?: string; maxKeys?: number },
): Promise<AuditSummary> {
	const max = q.maxKeys ?? SUMMARY_MAX_KEYS;
	const tally = new Map<string, Record<string, number>>();
	let scanned = 0;
	let next: string | null = q.cursor ?? null;
	let newest: number | null = null;
	let oldest: number | null = null;
	let done = false;
	while (scanned < max && !done) {
		const listed = await kv.list<AuditKeyMetadata>({ prefix: q.prefix, limit: 1000, ...(next ? { cursor: next } : {}) });
		for (const k of listed.keys) {
			const ms = keyTime(k.name, q.prefix);
			// Newest first: the first key older than `since` ends the window.
			if (q.since !== undefined && ms !== null && ms < q.since) {
				done = true;
				break;
			}
			if (q.until !== undefined && ms !== null && ms > q.until) continue;
			scanned++;
			if (ms !== null) {
				newest ??= ms;
				oldest = ms;
			}
			const tool = k.metadata?.tool ?? "(no metadata)";
			const action = k.metadata?.action ?? "(no metadata)";
			const counts = tally.get(tool) ?? {};
			counts[action] = (counts[action] ?? 0) + 1;
			tally.set(tool, counts);
		}
		if (listed.list_complete) done = true;
		next = done || listed.list_complete ? null : (listed.cursor ?? null);
		if (!next) done = true;
	}
	const tools = [...tally.entries()]
		.map(([tool, byAction]) => {
			const total = Object.values(byAction).reduce((a, b) => a + b, 0);
			return { tool, total, byAction, failures: FAILING.reduce((n, a) => n + (byAction[a] ?? 0), 0) };
		})
		.sort((a, b) => b.failures - a.failures || b.total - a.total || a.tool.localeCompare(b.tool));
	const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
	return {
		summary: true,
		scanned,
		window: { newest: iso(newest), oldest: iso(oldest), since: q.since === undefined ? null : iso(q.since), until: q.until === undefined ? null : iso(q.until) },
		tools,
		nextCursor: next,
		complete: next === null,
		note: "Counted from ledger key metadata, no events read. Successful read-only calls are never recorded, so a read tool's counts are its failures and denials only. With nextCursor set, the window was not finished: pass it back as cursor (same summarize/since/until) and add that page's counts to these.",
	};
}
