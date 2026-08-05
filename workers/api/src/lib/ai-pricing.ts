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
/**
 * Anthropic prompt-cache multipliers, relative to the model's input price.
 *
 * A cache READ is billed at 0.1x input, and WRITING the cache costs 1.25x (you pay a premium once
 * to save 90% on every later read). Folding both into plain input — which this did — overstates
 * cost whenever the cache works and understates the benefit of making it work.
 *
 * Ratios, not a per-model table: Anthropic defines them as multiples of the model's own input
 * price, so a new model needs no entry here.
 */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

export function estimateCostMicros(
	model: string | null | undefined,
	inputTokens: number | null | undefined,
	outputTokens: number | null | undefined,
	/** Cached tokens, priced at their own rates. Omit for providers without a prompt cache. */
	cache?: { read?: number | null; write?: number | null },
): number {
	const p = priceFor(model);
	const n = (v: number | null | undefined) => Math.max(0, Math.floor(Number(v) || 0));
	const inTok = n(inputTokens);
	const outTok = n(outputTokens);
	// tokens × (USD / 1e6 tokens) × 1e6 micros/USD  ⇒  tokens × USD-per-M, rounded.
	const micros =
		inTok * p.inputPerM +
		outTok * p.outputPerM +
		n(cache?.read) * p.inputPerM * CACHE_READ_MULTIPLIER +
		n(cache?.write) * p.inputPerM * CACHE_WRITE_MULTIPLIER;
	return Math.round(micros);
}

// ── Voice (OpenAI audio via the key-proxy) ────────────────────────────────
// A different unit from tokens: TTS bills per character, STT per minute of audio.
// TTS char-count is exact (we read the request `input`); STT duration is ESTIMATED
// from the uploaded audio bytes (we don't get duration back), so its cost is rough.

/** OpenAI tts-1 list price, USD per 1,000,000 characters. */
export const TTS_USD_PER_M_CHARS = 15;
/** OpenAI Whisper / gpt-4o-transcribe list price, USD per minute of audio. */
export const STT_USD_PER_MINUTE = 0.006;
/** Rough bytes-per-second for typical Opus/WebM voice (~20 kbps) — used only to
 *  turn an uploaded clip's size into an approximate duration for STT costing. */
export const VOICE_BYTES_PER_SEC = 2500;

/** Estimated TTS cost in micros of USD for `chars` characters (exact char count). */
export function estimateTtsMicros(chars: number): number {
	return Math.round(Math.max(0, Math.floor(Number(chars) || 0)) * TTS_USD_PER_M_CHARS);
}

/** Estimated STT cost in micros of USD for `seconds` of audio (seconds is itself an
 *  estimate from byte size — see VOICE_BYTES_PER_SEC). */
export function estimateSttMicros(seconds: number): number {
	const sec = Math.max(0, Number(seconds) || 0);
	// USD = (sec/60) × $/min ; micros = USD × 1e6.
	return Math.round((sec / 60) * STT_USD_PER_MINUTE * 1_000_000);
}

/** Approximate audio duration (seconds) from an uploaded clip's byte length. */
export function secondsFromAudioBytes(bytes: number): number {
	return Math.max(0, Math.round((Number(bytes) || 0) / VOICE_BYTES_PER_SEC));
}

/** Format micros of USD as a human dollar string (e.g. 1234567 → "$1.23"). */
export function formatUsd(micros: number): string {
	const usd = (Number(micros) || 0) / 1_000_000;
	if (usd === 0) return "$0.00";
	if (usd < 0.01) return `<$0.01`;
	return `$${usd.toFixed(2)}`;
}

// ── Platform-paid Workers AI (issue #44) ──────────────────────────────────
// Internal AI the PLATFORM pays for (embeddings/summaries/translation on env.AI)
// when PLATFORM_AI_ENABLED. Cloudflare bills Workers AI per *neuron*, not per token,
// and per-model neuron rates vary widely — so this is a deliberately ROUGH, nominal
// placeholder so platform spend reads as a non-zero, order-of-magnitude number that
// is attributable per user/kind. The AUTHORITATIVE figure comes from Cloudflare
// billing actuals (issue #45); UI/API label these as estimates.
export const PLATFORM_CF_PRICE: ModelPrice = { inputPerM: 0.1, outputPerM: 0.3 };

/** Estimated platform Workers-AI cost (micros USD) for a call. See PLATFORM_CF_PRICE. */
export function estimatePlatformCostMicros(
	inputTokens: number | null | undefined,
	outputTokens: number | null | undefined,
): number {
	const inTok = Math.max(0, Math.floor(Number(inputTokens) || 0));
	const outTok = Math.max(0, Math.floor(Number(outputTokens) || 0));
	return Math.round(inTok * PLATFORM_CF_PRICE.inputPerM + outTok * PLATFORM_CF_PRICE.outputPerM);
}

/** Rough token count from character length (~4 chars/token) — for call sites that
 *  don't get usage back from Workers AI (embeddings, CF llama translate). */
export function approxTokens(chars: number | null | undefined): number {
	return Math.ceil(Math.max(0, Number(chars) || 0) / 4);
}
