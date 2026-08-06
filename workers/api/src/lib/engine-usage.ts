/**
 * Engine spend arriving from a runner (#267) — the pure half.
 *
 * The coding Engine is a child process on the user's own machine, so it never passes through
 * `runUserWorkersAi` / `recordVoiceUsage` / `recordPlatformUsage`, the three places `ai_usage` is
 * written. Its consumption — the largest line for anyone using Coder in earnest — was recorded
 * nowhere, and nothing on the Usage page said so.
 *
 * Claude Code reports token counts AND `total_cost_usd` on the `result` event that ends each
 * turn; the runner now drains those into the capture response. This module validates what comes
 * back before it reaches D1: the payload crosses the relay from a machine we do not control, so
 * it is treated as input, not as truth about types.
 */

/** One engine turn's measured spend, as the runner reports it. */
export interface EngineUsageReport {
	id: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
}

/** Cap per drain — a compromised or buggy runner must not be able to bulk-insert into D1. */
const MAX_RECORDS = 200;
/** A single turn costing more than this is not a turn; refuse it rather than poison the total. */
const MAX_COST_USD = 1000;
const MAX_TOKENS = 1_000_000_000;

const posInt = (v: unknown, cap: number): number => {
	const n = Math.floor(Number(v));
	return Number.isFinite(n) && n > 0 ? Math.min(n, cap) : 0;
};

/**
 * Validate a runner's reported usage array into rows worth inserting.
 *
 * Drops anything with no id (there would be no dedup key, so a re-report would double-count) and
 * anything measuring nothing at all. An all-zero record is discarded rather than written, for the
 * same reason a raw engine writes nothing: a zero row reads as "this engine was free", which is
 * a stronger and more wrong claim than saying nothing.
 */
export function sanitizeEngineUsage(raw: unknown): EngineUsageReport[] {
	if (!Array.isArray(raw)) return [];
	const out: EngineUsageReport[] = [];
	const seen = new Set<string>();
	for (const item of raw.slice(0, MAX_RECORDS)) {
		if (!item || typeof item !== "object") continue;
		const r = item as Record<string, unknown>;
		const id = typeof r.id === "string" ? r.id.trim().slice(0, 200) : "";
		// No id means no dedup key. Inserting it would be a row that double-counts on any retry,
		// which is worse than the gap it fills.
		if (!id || seen.has(id)) continue;
		const inputTokens = posInt(r.inputTokens, MAX_TOKENS);
		const outputTokens = posInt(r.outputTokens, MAX_TOKENS);
		const cacheReadTokens = posInt(r.cacheReadTokens, MAX_TOKENS);
		const cacheWriteTokens = posInt(r.cacheWriteTokens, MAX_TOKENS);
		const costRaw = Number(r.costUsd);
		const costUsd = Number.isFinite(costRaw) && costRaw > 0 ? Math.min(costRaw, MAX_COST_USD) : 0;
		if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheWriteTokens && !costUsd) continue;
		seen.add(id);
		out.push({
			id,
			model: (typeof r.model === "string" && r.model.trim() ? r.model.trim() : "unknown").slice(0, 120),
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			costUsd,
		});
	}
	return out;
}

/**
 * The ledger's primary key for an engine row.
 *
 * Deterministic on purpose: several cloud paths can drain and write the same turn (a capture poll
 * racing the Pilot's own capture, or a retried step), and `INSERT OR IGNORE` on this key turns
 * that race into a no-op instead of a duplicate charge. Namespaced by session so two sessions
 * cannot collide on a CLI-supplied uuid.
 */
export function engineUsageRowId(sessionId: string, recordId: string): string {
	return `engine:${sessionId}:${recordId}`.slice(0, 300);
}
