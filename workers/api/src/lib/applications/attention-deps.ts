/**
 * The owner-attention delivery wiring for the application stages (#991) — moved out of
 * `local-apply/apply.ts` unchanged when the Tailor and the run signals (#1107) needed the same one.
 */
import type { AttentionDeps } from "../owner-attention.js";
import { parseAccountPreferences } from "../preferences.js";
import { notifyUser } from "../../routes/push.js";
import type { Env } from "../../types.js";

/**
 * How this consumer reaches the delivery stack (#991).
 *
 * Injected rather than imported inside `requestOwnerAttention` so the policy module stays testable
 * without the push stack, and so the push OUTCOME is read from the row that was written rather than
 * assumed: `notifyUser` is best-effort about the push by design, so "did it actually go" is a
 * question only the notifications table can answer.
 */
export const attentionDeps: AttentionDeps<Env> = {
	notify: async (env, userId, type, title, body, url, opts) => { await notifyUser(env, userId, type, title, body, url, opts); },
	pushed: async (env, userId, ids) => {
		// Read the row that was just written, by the key the notifications table actually stores.
		// `pushed_at` is set when an interruption was RAISED, and an attention event is an `alert`,
		// which no per-type mute can suppress — so a null there means the 10-minute duplicate
		// window swallowed it, and that is the one case worth telling the owner apart.
		const row = await env.DB.prepare("SELECT pushed_at FROM notifications WHERE user_id = ?1 AND dedupe_key = ?2 ORDER BY created_at DESC LIMIT 1")
			.bind(userId, ids.dedupeKey)
			.first<{ pushed_at: string | null }>()
			.catch(() => null);
		if (!row) return "unavailable";
		if (!row.pushed_at) return "deduped";
		// An interruption was raised; whether a device received it depends on there being one. No
		// subscription means the owner has nothing to buzz, and saying "notified" would be the lie.
		const device = await env.DB.prepare("SELECT 1 FROM push_subscriptions WHERE user_id = ?1 LIMIT 1")
			.bind(userId)
			.first()
			.catch(() => null);
		return device ? "sent" : "unavailable";
	},
	preferences: async (env, userId) => {
		const row = await env.DB.prepare("SELECT preferences FROM users WHERE id = ?1").bind(userId).first<{ preferences: string | null }>();
		const prefs = parseAccountPreferences(row?.preferences);
		// `parseAccountPreferences` has already sanitized both sections — this is the stored account,
		// read through the one parser, not a second interpretation of the same JSON.
		return { notifications: prefs.notifications, attention: prefs.attention };
	},
};
