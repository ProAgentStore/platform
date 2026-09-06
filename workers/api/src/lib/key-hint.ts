/**
 * How many trailing characters a hint may carry. FOUR, and the number is the constraint rather
 * than a tuning knob (#780): enough to tell two of your own keys apart, not enough to be worth
 * anything to anyone else. Widening it is a security change, so the tests assert against this
 * constant — a bump has to happen here, deliberately, once.
 */
export const KEY_HINT_LENGTH = 4;

/**
 * Below this, four characters stops being a hint and becomes a share of the key. A real provider
 * key is 40–120 characters, so this only ever refuses something that was not one: a placeholder,
 * a truncated paste, a test stub. Those get no hint rather than a revealing one.
 */
const MIN_HINTABLE_LENGTH = 12;

/**
 * The non-secret display hint for a stored key, or null when there is nothing safe to show.
 *
 * Takes the STORED PLAINTEXT — what `decryptKey` returns, and what the PUT handler is about to
 * encrypt — so the write path and the lazy-backfill path cannot drift into computing it two
 * different ways.
 *
 * Cloudflare Workers AI is the one provider whose stored plaintext is not a key: it is
 * `{"accountId":…,"token":…}` from `encodeCloudflareAiCredentials`. Hinting that raw string would
 * name the last 4 characters of the ENCODING (`"}` and two of the token) — useless, and not what
 * the owner pasted. The JSON is unwrapped here rather than by calling
 * `parseCloudflareAiCredentials`: `user-ai.ts` imports THIS module to backfill after its own
 * decrypts, so importing it back would be a cycle. It is six lines and only the `{`-prefixed
 * form can occur, the colon form being a legacy read-path shape whose token is a suffix — so its
 * last 4 characters are the string's last 4 either way.
 *
 * NEVER returns the middle, and never more than `KEY_HINT_LENGTH`. The `sk-ant-` prefix is fixed
 * and carries no information, so the tail is the whole discriminator.
 */
export function keyHint(storedPlaintext: string | null | undefined): string | null {
	const raw = (storedPlaintext || "").trim();
	if (!raw) return null;
	let secret = raw;
	if (raw.startsWith("{")) {
		try {
			const token = (JSON.parse(raw) as { token?: unknown }).token;
			if (typeof token === "string" && token.trim()) secret = token.trim();
		} catch {
			// Not the Cloudflare envelope after all — a key that merely begins with `{`. Hint the
			// string as stored; there is nothing to unwrap and nothing has gone wrong.
		}
	}
	if (secret.length < MIN_HINTABLE_LENGTH) return null;
	return secret.slice(-KEY_HINT_LENGTH);
}
