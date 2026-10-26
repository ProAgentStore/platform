/**
 * What KIND of failure an AI provider's refusal is — decided once, here (#1356).
 *
 * "Is this credit or credentials?" used to be answered separately at several sites: the Anthropic branch of `user-ai.ts` (to pick a hint and
 * to record a hold), `coding-failure.ts` (a marker list over the message, plus status numbers), and the probe and verify paths that read
 * the result. They agreed because they were kept in step by a test, not because they shared a decision. Now each ADAPTER calls the
 * classifier below when it builds its error and stamps the result on it; every other reader asks {@link providerErrorKind}.
 *
 * The kind travels two ways, because a Workflow step boundary keeps an error's message and drops its properties: as a field on
 * `UserAiProviderError`, and as a tag at the END of its message (` [provider-error:credit]`, the shape `runner-unreachable.ts` gave runner
 * failures in #1355). A message with no tag — written before this, or by something that is not an adapter — has no kind, and its readers
 * fall back to the wording they always read.
 *
 * A leaf: the adapters, the failure classifier and the routes all import it, so it imports nothing.
 */

/**
 *   credit       the account behind the key has no balance — a top-up fixes it, a retry does not.
 *   credentials  the provider refused the key itself (401/403) — the owner fixes the key.
 *   rate_limit   a throttle; it reopens by itself.
 *   model_access the key is valid but cannot reach the model asked for (404).
 *   server       the provider failed (5xx, including 529 overloaded) — a retry may succeed.
 *   other        a refusal that is none of the above (a malformed request, an unclassified 4xx).
 */
export type ProviderErrorKind = "credit" | "credentials" | "rate_limit" | "model_access" | "server" | "other";

const KINDS: ReadonlySet<string> = new Set<ProviderErrorKind>(["credit", "credentials", "rate_limit", "model_access", "server", "other"]);

const TAG = /\[provider-error:([a-z_]+)\]/;

/** The tag an adapter appends to its message. At the END, so patterns anchored on the provider's own framing still hold. */
export function providerErrorTag(kind: ProviderErrorKind): string {
	return ` [provider-error:${kind}]`;
}

/** The message without its tag — for a reader that shows it to a person. */
export function withoutProviderErrorTag(message: string): string {
	return message.replace(/ ?\[provider-error:[a-z_]+\]/g, "");
}

/**
 * The kind an adapter decided, from the error's field or — across a step boundary — its tag. Null when nothing decided one.
 * A field wins: it was set by the code that knew; the tag is its copy.
 */
export function providerErrorKind(e: unknown): ProviderErrorKind | null {
	const own = (e as { kind?: unknown } | null)?.kind;
	if (typeof own === "string" && KINDS.has(own)) return own as ProviderErrorKind;
	const msg = typeof (e as { message?: unknown } | null)?.message === "string" ? (e as { message: string }).message : typeof e === "string" ? e : "";
	const tagged = TAG.exec(msg)?.[1];
	return tagged && KINDS.has(tagged) ? (tagged as ProviderErrorKind) : null;
}

/**
 * Does a provider's error sentence say the account is out of money? (#773)
 *
 * Anthropic: "Your credit balance is too low to access the Anthropic API." Matched loosely on the noun phrase rather than the whole
 * sentence, so a reworded suffix does not silently drop the kind. An exhausted balance arrives as a 400 `invalid_request_error` — the
 * same status and type as a malformed request — so the sentence is its only signature.
 */
export function isCreditBalanceMessage(message: string): boolean {
	const m = message.toLowerCase();
	return m.includes("credit balance") || m.includes("insufficient_funds") || m.includes("insufficient credit");
}

/**
 * Anthropic's refusal, by status and its own sentence. The credit sentence is read BEFORE the status: a balance failure must not be filed
 * as a bad key even when it arrives on a 401/403, because the two send the owner to different pages and only one of them is a top-up.
 */
export function classifyAnthropicError(input: { status: number; message: string }): ProviderErrorKind {
	const { status, message } = input;
	if (status === 402 || isCreditBalanceMessage(message)) return "credit";
	if (status === 401 || status === 403) return "credentials";
	if (status === 404) return "model_access";
	if (status === 429) return "rate_limit";
	if (status >= 500) return "server";
	return "other";
}

/** Cloudflare Workers AI's refusal: it speaks only in HTTP status. */
export function classifyCloudflareError(input: { status: number }): ProviderErrorKind {
	const { status } = input;
	if (status === 402) return "credit";
	if (status === 401 || status === 403) return "credentials";
	if (status === 429) return "rate_limit";
	if (status >= 500) return "server";
	return "other";
}
