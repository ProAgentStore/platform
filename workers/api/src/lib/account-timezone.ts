// The owner's timezone, read from the account blob (#329/#345).
//
// A LEAF module on purpose: it imports the pure parser and nothing else. It started life private to
// `tool-registry.ts`, but the second caller (`connectors/supervision.ts`) cannot import that file —
// tool-registry imports the connector registry, which imports supervision, so reusing it there
// would have closed a cycle. Copying the four lines instead is how two code paths end up
// disagreeing about where a preference lives.
//
// Undefined on ANY failure, which is the honest unset state (#329): the callers then name UTC out
// loud rather than dressing a guess up as the user's local time.

import { parseAccountPreferences } from "./preferences.js";
import type { Env } from "../types.js";

/**
 * The IANA zone this user set, or undefined when they have not set one.
 *
 * One indexed lookup on `users`. Call sites that already join the owner's preferences (the chat
 * prompt does) should keep using what they have — this is for the paths that have a `userId` and
 * nothing else.
 */
export async function accountTimeZone(env: Env, userId: string): Promise<string | undefined> {
	if (!userId) return undefined;
	try {
		const row = await env.DB.prepare("SELECT preferences FROM users WHERE id = ?1")
			.bind(userId)
			.first<{ preferences: string | null }>();
		return parseAccountPreferences(row?.preferences).timezone;
	} catch {
		return undefined;
	}
}
