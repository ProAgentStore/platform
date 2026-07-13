// AI cost estimation. BYOK means we never see the user's actual provider bill —
// we price `tokens × published list price` per model so the Usage page can answer
// "what did this agent cost me" within a few percent. Update PRICES as list prices
// change. Cost is stored as integer **micros of USD** (1 USD = 1_000_000 micros) to
// keep the ledger integer-only (no float drift when summing millions of rows).

export interface ModelPrice {
	/** USD per 1,000,000 input tokens. */
	inputPerM: number;
	/** USD per 1,000,000 output tokens. */
	outputPerM: number;
}

// Keyed by a normalized model id (see normalizeModel). Prices in USD / 1M tokens,
// list price as published by the provider. Cache reads bill at the input rate here
// (we already fold cache_read/creation into `input` in user-ai.ts), which slightly
// over-estimates cached calls — acceptable for a BYOK estimate.
export const PRICES: Record<string, ModelPrice> = {
	// Anthropic (claude-sonnet-4-6 is the default the Anthropic path always uses)
	"claude-sonnet-4-6": { inputPerM: 3, outputPerM: 15 },
	"claude-sonnet-4": { inputPerM: 3, outputPerM: 15 },
	"claude-opus-4": { inputPerM: 15, outputPerM: 75 },
	"claude-haiku-4": { inputPerM: 1, outputPerM: 5 },
	"claude-3-5-haiku": { inputPerM: 0.8, outputPerM: 4 },
	"claude-3-5-sonnet": { inputPerM: 3, outputPerM: 15 },
	// Cloudflare Workers AI — priced per Neuron by CF, not per token; treat as ~free
	// for estimation (the meaningful spend is the BYOK Anthropic path).
	"cf": { inputPerM: 0, outputPerM: 0 },
};

// A conservative default for an unknown model so an untracked model still shows a
// non-zero, order-of-magnitude cost instead of silently reading as free.
export const DEFAULT_PRICE: ModelPrice = { inputPerM: 3, outputPerM: 15 };

/**
 * Collapse a raw model id to a PRICES key. Handles version/date suffixes
 * (`claude-sonnet-4-6-20260101`), provider prefixes (`anthropic/…`), and the
 * `@cf/…` Workers-AI namespace (all mapped to the `cf` ~free bucket).
 */
export function normalizeModel(model: string | null | undefined): string {
	const m = (model || "").toLowerCase().trim();
	if (!m) return "claude-sonnet-4-6";
	if (m.startsWith("@cf/") || m.includes("workers-ai")) return "cf";
	const bare = m.replace(/^anthropic\//, "");
	// Longest-prefix match against known keys (so `claude-sonnet-4-6-2026…` → `claude-sonnet-4-6`).
	let best = "";
	for (const key of Object.keys(PRICES)) {
		if (bare.startsWith(key) && key.length > best.length) best = key;
	}
	return best || bare;
}

export function priceFor(model: string | null | undefined): ModelPrice {
	const key = normalizeModel(model);
	return PRICES[key] ?? DEFAULT_PRICE;
}

/**
 * Estimated cost of one call, in integer micros of USD. Never negative; tolerates
 * missing/garbage token counts (treated as 0).
 */
export function estimateCostMicros(
	model: string | null | undefined,
	inputTokens: number | null | undefined,
	outputTokens: number | null | undefined,
): number {
	const p = priceFor(model);
	const inTok = Math.max(0, Math.floor(Number(inputTokens) || 0));
	const outTok = Math.max(0, Math.floor(Number(outputTokens) || 0));
	// tokens × (USD / 1e6 tokens) × 1e6 micros/USD  ⇒  tokens × USD-per-M, rounded.
	const micros = inTok * p.inputPerM + outTok * p.outputPerM;
	return Math.round(micros);
}

/** Format micros of USD as a human dollar string (e.g. 1234567 → "$1.23"). */
export function formatUsd(micros: number): string {
	const usd = (Number(micros) || 0) / 1_000_000;
	if (usd === 0) return "$0.00";
	if (usd < 0.01) return `<$0.01`;
	return `$${usd.toFixed(2)}`;
}
