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

/** Human labels for the refusal message, article included so the sentence reads correctly. */
const LABELS: Record<string, { a: string; name: string }> = {
	anthropic: { a: "an Anthropic", name: "Anthropic" },
	openrouter: { a: "an OpenRouter", name: "OpenRouter" },
	groq: { a: "a Groq", name: "Groq" },
	xai: { a: "an xAI", name: "xAI" },
	google: { a: "a Google AI", name: "Google AI" },
	openai: { a: "an OpenAI", name: "OpenAI" },
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
	const from = LABELS[identified]?.a ?? `a ${identified}`;
	const to = LABELS[providerId]?.name ?? providerId;
	return `That looks like ${from} key, not ${to}. Check you pasted it into the right provider.`;
}

/** A Cloudflare account ID: 32 hex characters, as the dashboard shows it. */
const CLOUDFLARE_ACCOUNT_ID = /^[0-9a-f]{32}$/i;

/**
 * Reject a Cloudflare Workers AI pair whose account ID is not an account ID (#893).
 *
 * The account ID is the one half with a fixed, documented shape, so it is the half checked —
 * and checking it catches the swap that put a live token into the account-ID slot, where
 * Cloudflare's 404 then quoted it back. The token's shape is NOT allowlisted, for the reason this
 * file opens with; it is refused only when it is itself account-ID-shaped, which is the other half
 * of the same swap. Neither message quotes the values: these are credentials.
 */
export function cloudflareCredentialsError(accountId: string, token: string): string | null {
	const id = (accountId || "").trim();
	const tok = (token || "").trim();
	const tokenIsAnId = CLOUDFLARE_ACCOUNT_ID.test(tok);
	if (!CLOUDFLARE_ACCOUNT_ID.test(id)) {
		return tokenIsAnId
			? "The Account ID and API token look swapped: the token field holds a 32-character hex account ID, and the Account ID field does not. Paste each into the other field."
			: "That Account ID is not a Cloudflare account ID — it must be the 32-character hex ID the Cloudflare dashboard shows for your account, not the API token.";
	}
	if (tokenIsAnId) {
		return "The API token field holds a 32-character hex account ID, not an API token. Paste the API token from dash.cloudflare.com/profile/api-tokens.";
	}
	return null;
}
