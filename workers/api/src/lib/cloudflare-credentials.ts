/**
 * The Cloudflare Workers AI credential, as it is stored and as it is read (#1356).
 *
 * ONE parser. `user-ai.ts` decrypts and reads the credential with it, and `provider-account-observation.ts` fingerprints it with it. The
 * observation module used to carry its own copy of the colon form, which built a wrong account id from a value that had no colon
 * (`slice(0, -1)` of the whole string) instead of refusing it — so two readers of one stored value could disagree about what it was.
 *
 * A leaf: both of those import it, so it imports nothing.
 */

export interface StoredCloudflareAiCredentials {
	accountId: string;
	token: string;
}

/** The stored form: the account id and token as one JSON envelope. */
export function encodeCloudflareAiCredentials(accountId: string, token: string): string {
	return JSON.stringify({ accountId, token });
}

/**
 * Read a stored credential: the JSON envelope, or the older `accountId:token` form. Null for anything else — an empty value, an
 * envelope missing a half, a colon form with nothing before the colon. Never throws.
 */
export function parseCloudflareAiCredentials(raw: string): StoredCloudflareAiCredentials | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;

	if (trimmed.startsWith("{")) {
		try {
			const data = JSON.parse(trimmed) as Partial<StoredCloudflareAiCredentials>;
			if (data.accountId?.trim() && data.token?.trim()) {
				return { accountId: data.accountId.trim(), token: data.token.trim() };
			}
		} catch {
			return null;
		}
		return null;
	}

	const separator = trimmed.indexOf(":");
	if (separator > 0) {
		const accountId = trimmed.slice(0, separator).trim();
		const token = trimmed.slice(separator + 1).trim();
		if (accountId && token) return { accountId, token };
	}

	return null;
}
