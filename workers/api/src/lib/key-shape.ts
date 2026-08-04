// Which provider a pasted API key obviously belongs to (#keys).
//
// The check this replaces required a key to START WITH the provider's known prefix, and rejected
// everything else. That is an allowlist of the provider's OWN format, so it rots every time a
// provider changes theirs — and it rots CLOSED, hard-blocking a valid key. Google did exactly
// that: AI Studio now issues `AQ.…` keys while the check still demanded `AIza…`, so a working
// key could not be saved at all.
//
// The thing the check is actually for is catching a paste into the wrong slot — an Anthropic key
// in the OpenAI box. That is better served by recognising OTHER providers' formats, because those
// are what you are guarding against, and an unfamiliar format is far more likely to be a new
// format than a mistake. So: reject only what clearly belongs elsewhere; accept the unknown.

/** Distinctive prefixes, MOST SPECIFIC FIRST — `sk-ant-` and `sk-or-` both start with `sk-`. */
const SIGNATURES: ReadonlyArray<{ prefix: string; provider: string }> = [
	{ prefix: "sk-ant-", provider: "anthropic" },
	{ prefix: "sk-or-", provider: "openrouter" },
	{ prefix: "gsk_", provider: "groq" },
	{ prefix: "xai-", provider: "xai" },
	{ prefix: "AIza", provider: "google" },
	// Least specific last: a bare `sk-` that matched none of the above.
	{ prefix: "sk-", provider: "openai" },
];

/** Human labels for the refusal message. */
const LABELS: Record<string, string> = {
	anthropic: "Anthropic",
	openrouter: "OpenRouter",
	groq: "Groq",
	xai: "xAI",
	google: "Google AI",
	openai: "OpenAI",
};

/** The provider a key's shape identifies, or null when the shape is unfamiliar. */
export function identifyKeyProvider(key: string): string | null {
	const k = (key || "").trim();
	for (const s of SIGNATURES) if (k.startsWith(s.prefix)) return s.provider;
	return null;
}

/**
 * Reject a key only when it clearly belongs to a DIFFERENT provider.
 *
 * Returns an error message, or null to accept — including for a shape we do not recognise, which
 * is the case that used to fail. A new format from the right provider must not be blocked by our
 * not having heard of it yet.
 */
export function wrongProviderError(providerId: string, key: string): string | null {
	const identified = identifyKeyProvider(key);
	if (!identified || identified === providerId) return null;
	return `That looks like ${LABELS[identified] ?? identified} key, not ${LABELS[providerId] ?? providerId}. Check you pasted it into the right provider.`;
}
