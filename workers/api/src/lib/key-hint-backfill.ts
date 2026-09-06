import { keyHint } from "./key-hint.js";
import type { Env } from "../types.js";

/**
 * Give a stored key its display hint, for rows written before `key_hint` existed (#780,
 * migration 0146).
 *
 * WHY IT HANGS OFF THE DECRYPT PATHS AND NOT THE READ. The console asks for hints on every visit
 * to Profile via `/v1/keys/status`. Backfilling there would mean decrypting every stored key to
 * render a page — which is precisely what `/reveal` is deliberately rate-limited and audited to
 * prevent being routine. So the hint is filled in by the callers that ALREADY hold the plaintext
 * for their own reasons: the key proxy, `/reveal`, and the BYOK AI calls. The owner never
 * re-enters a key; the row gains its hint the next time the platform uses it. This is the shape
 * `0035_gmail_account_label.sql` established on this same table.
 *
 * `currentHint` is what the caller's own SELECT already read, and a non-null value returns before
 * touching D1 at all. Without it this would issue a statement on EVERY chat turn — the AI path
 * calls it per request — and rely on `key_hint IS NULL` to match nothing, paying a round trip
 * forever to do nothing. `key_hint IS NULL` stays in the WHERE anyway, as the concurrency guard
 * that makes the write itself one-shot.
 *
 * `accountId` is REQUIRED and explicit rather than defaulted. Several callers select a row with
 * `.first()` under a WHERE that does not name an account (`user_id` + `provider` only), and a
 * connector can hold several accounts (#715). An UPDATE with that same loose WHERE could stamp
 * one account's hint onto another account's row — a wrong hint is worse than no hint, because it
 * is the answer to "which key is this" and it would be confidently false.
 *
 * Never throws: a failed cosmetic backfill must not fail the AI call or the proxied request it is
 * riding on.
 */
export async function backfillKeyHint(
	env: Env,
	userId: string,
	provider: string,
	accountId: string,
	plaintext: string,
	currentHint: string | null | undefined,
): Promise<void> {
	if (currentHint) return;
	const hint = keyHint(plaintext);
	if (!hint) return;
	try {
		await env.DB.prepare(
			"UPDATE user_api_keys SET key_hint = ?1 WHERE user_id = ?2 AND provider = ?3 AND account_id = ?4 AND key_hint IS NULL",
		)
			.bind(hint, userId, provider, accountId)
			.run();
	} catch {
		// Deliberately silent. This is a display nicety attached to paths whose real job is
		// spending a key or proxying a request; a D1 hiccup here must not turn a working chat turn
		// into an error. The row simply stays unhinted and the next use tries again.
	}
}
