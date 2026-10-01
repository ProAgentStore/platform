/**
 * Redaction for anything Cloudflare says back about a request made with the owner's credentials (#893).
 *
 * Cloudflare's errors quote the request — a 404 reads `Could not route to /client/v4/accounts/<id>/…` —
 * so once a token lands in the account-ID slot, its own error text carries the token. Text from
 * there is never surfaced raw: the account path segment is masked whatever it holds, and so is
 * every occurrence of either stored value, wherever else the upstream chose to repeat it.
 */
import { makeSecretRedactor, redactEventData, SECRET_MASK } from "./redact-secrets.js";

const ACCOUNT_PATH = /\/accounts\/[^/\s"'?]+/gi;

export function redactCloudflareUpstream<T>(value: T, credentials: { accountId: string; token: string }): T {
	const known = makeSecretRedactor([credentials.accountId, credentials.token]);
	const redact = (text: string) => known(text).replace(ACCOUNT_PATH, `/accounts/${SECRET_MASK}`);
	return redactEventData(value, redact) as T;
}
