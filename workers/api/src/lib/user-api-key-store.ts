import { encryptKey } from "./crypto.js";
import { keyHint } from "./key-hint.js";
import type { Env } from "../types.js";

/**
 * Encrypt and store the owner's key for one provider in the unnamed default slot.
 *
 * Shared by `PUT /v1/keys/:provider` and the engine re-auth relay (#881), which replaces a stale
 * `claude-code` token with the one `claude setup-token` just printed. One writer, so the two cannot
 * disagree about encryption or the display hint.
 */
export async function upsertUserProviderKey(env: Env, userId: string, providerId: string, keyToStore: string): Promise<void> {
	if (!env.KEY_ENCRYPTION_KEY) throw new Error("Key encryption not configured");
	const { ciphertext, dekWrapped, iv } = await encryptKey(keyToStore, env.KEY_ENCRYPTION_KEY);
	await env.DB.prepare(
		// account_id '' — the unnamed default. An AI provider key is singular by nature (you have
		// one Anthropic key), so it stays in the slot it has always occupied; the multi-account
		// vault (#715) is for connectors whose credential names a mailbox or a drive.
		`INSERT INTO user_api_keys (user_id, provider, account_id, key_ciphertext, dek_wrapped, iv, created_at, key_hint)
     VALUES (?1, ?2, '', ?3, ?4, ?5, datetime('now'), ?6)
     ON CONFLICT(user_id, provider, account_id) DO UPDATE SET
       key_ciphertext = excluded.key_ciphertext,
       dek_wrapped = excluded.dek_wrapped,
       iv = excluded.iv,
       created_at = excluded.created_at,
       -- Overwritten, not coalesced: replacing the key replaces which key this is, and a stale
       -- hint would name the key the owner just took OUT of the slot (#780).
       key_hint = excluded.key_hint`,
	)
		// The hint is derived from `keyToStore`, the same string being encrypted above — for
		// cloudflare that is the `{accountId,token}` envelope, which `keyHint` unwraps so the hint
		// names the token the owner pasted rather than the encoding.
		.bind(userId, providerId, ciphertext, dekWrapped, iv, keyHint(keyToStore))
		.run();
}

/** Does the owner hold a key for this provider? Presence only — nothing is decrypted. */
export async function hasUserProviderKey(env: Env, userId: string, providerId: string): Promise<boolean> {
	const row = await env.DB.prepare("SELECT 1 AS present FROM user_api_keys WHERE user_id = ?1 AND provider = ?2 LIMIT 1")
		.bind(userId, providerId)
		.first<{ present: number }>();
	return !!row;
}
