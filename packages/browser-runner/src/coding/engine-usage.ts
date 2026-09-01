/**
 * Engine spend, taken from the CLI's OWN report (#267).
 *
 * The usage ledger is written at three cloud-side choke points (`runUserWorkersAi`,
 * `recordVoiceUsage`, `recordPlatformUsage`). The coding Engine passes through none of them: it
 * is a child process on the user's machine talking straight to Anthropic. So the single largest
 * line item for anyone using Coder in earnest was recorded nowhere, and the Usage page showed a
 * total with no hint that it was incomplete.
 *
 * Claude Code already emits everything needed on the `result` event that ends each turn — token
 * counts AND `total_cost_usd`, which it computes itself. That number is the one figure in the
 * whole ledger that is NOT an estimate, so it is carried through as reported rather than being
 * re-derived from `ai-pricing.ts` list prices.
 *
 * Raw engines never reach this module: `HeadlessSession` only parses usage from structured engine
 * events. Codex `exec --json` reports tokens but no dollar figure on the observed 0.151.0 schema,
 * so those rows carry provider `openai`, model `codex`, and `costUsd: 0` without pretending the CLI
 * reported a price.
 */

/** One engine turn's measured spend. The wire shape between runner and cloud. */
export interface EngineUsageRecord {
	/** Provider whose CLI reported this turn. Older runners omit it and the cloud defaults Claude. */
	provider?: string;
	/**
	 * Stable per-turn id, so reporting the same record twice is harmless.
	 *
	 * The cloud inserts with a deterministic primary key and ignores conflicts, which is what
	 * lets several capture callers race without double-counting a turn.
	 */
	id: string;
	/** Real model id as the CLI reports it (e.g. `claude-opus-5`), or "unknown". */
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** `total_cost_usd` — computed by the CLI, not estimated by us. */
	costUsd: number;
	/** ISO timestamp of the turn boundary (runner wall-clock). */
	at: string;
}

const num = (v: unknown): number => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Pick the model id out of Claude Code's `modelUsage` map, which is keyed by model.
 *
 * A single turn can legitimately span more than one model (a subagent on a cheaper one), and the
 * ledger has one model column per row. The most expensive one is the honest label for the row:
 * attributing the turn to the cheap helper model would make an expensive session look cheap in
 * the by-model breakdown, which is the exact question that breakdown exists to answer.
 */
function pickModel(modelUsage: unknown): string {
	if (!modelUsage || typeof modelUsage !== "object") return "unknown";
	let best = "";
	let bestCost = -1;
	for (const [model, entry] of Object.entries(modelUsage as Record<string, unknown>)) {
		const cost = num((entry as { costUSD?: unknown } | null)?.costUSD);
		if (cost > bestCost) {
			bestCost = cost;
			best = model;
		}
	}
	return best || "unknown";
}

/**
 * Turn a stream-json `result` event into a usage record, or null when it carries no measurement.
 *
 * `fallbackId` is used only when the event has no `uuid` of its own (older Claude Code builds);
 * the caller supplies something unique per turn per process.
 *
 * Returns null — never a zeroed record — when there is nothing to report, for the same reason
 * raw engines record nothing: an all-zero row is indistinguishable from "this was free".
 */
export function parseEngineUsage(ev: unknown, fallbackId: string): EngineUsageRecord | null {
	if (!ev || typeof ev !== "object") return null;
	const e = ev as Record<string, unknown>;
	if (e.type === "turn.completed") return parseCodexUsage(e, fallbackId);
	if (e.type !== "result") return null;

	const usage = (e.usage && typeof e.usage === "object" ? e.usage : {}) as Record<string, unknown>;
	const inputTokens = num(usage.input_tokens);
	const outputTokens = num(usage.output_tokens);
	const cacheReadTokens = num(usage.cache_read_input_tokens);
	const cacheWriteTokens = num(usage.cache_creation_input_tokens);
	const costUsd = num(e.total_cost_usd);

	if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheWriteTokens && !costUsd) return null;

	const uuid = typeof e.uuid === "string" && e.uuid.trim() ? e.uuid.trim() : "";
	return {
		id: uuid || fallbackId,
		provider: "anthropic",
		model: pickModel(e.modelUsage),
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		costUsd,
		at: new Date().toISOString(),
	};
}

function parseCodexUsage(e: Record<string, unknown>, fallbackId: string): EngineUsageRecord | null {
	const usage = (e.usage && typeof e.usage === "object" ? e.usage : {}) as Record<string, unknown>;
	const inputTokens = num(usage.input_tokens);
	const outputTokens = num(usage.output_tokens);
	const cacheReadTokens = num(usage.cached_input_tokens);
	const cacheWriteTokens = num(usage.cache_write_input_tokens);
	if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheWriteTokens) return null;

	return {
		id: fallbackId,
		provider: "openai",
		model: "codex",
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		costUsd: 0,
		at: new Date().toISOString(),
	};
}
