/**
 * Account preferences — how YOU speak, hear and read, across every agent (#211).
 *
 * Voice and translation used to live only on `agent_instances.config`, so both had to be configured
 * once per agent, and a new subscription seeded neither. Neither is a property of an agent.
 *
 * An agent can still differ: `PUT /v1/instances/:id/voice-settings` writes a per-instance override,
 * and `DELETE` clears it back to these defaults. Every clamp and the precedence chain live in the
 * pure `lib/preferences.ts`, shared with those routes so the two can't drift.
 *
 * `timezone` joined them for #329 and is the same kind of thing — a property of the person, read by
 * every surface that shows a time. `GET /` is the single source both the chat prompt and the console
 * read it from, so a run cannot be narrated in one zone and rendered in another.
 */
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { isValidTimeZone } from "../lib/cron-time.js";
import {
	parseAccountPreferences,
	sanitizeTranslationSettings,
	sanitizeVoiceSettings,
	unknownVoiceField,
	type AccountPreferences,
} from "../lib/preferences.js";
import { TRANSLATION_LANGUAGES } from "./instances-translation.js";
import type { Env } from "../types.js";

export const preferenceRoutes = new Hono<{ Bindings: Env }>();

async function readPreferences(env: Env, userId: string): Promise<AccountPreferences> {
	const row = await env.DB.prepare("SELECT preferences FROM users WHERE id = ?1")
		.bind(userId)
		.first<{ preferences: string | null }>();
	return parseAccountPreferences(row?.preferences);
}

preferenceRoutes.get("/", async (c) => {
	const session = await requireUser(c);
	// The language list rides along: the Preferences page needs it to render the translation
	// target, and it has no instance to ask. Owned by instances-translation.ts, not duplicated.
	return c.json({ preferences: await readPreferences(c.env, session.uid), languages: TRANSLATION_LANGUAGES });
});

/**
 * Save one or both sections. PATCH semantics at the SECTION level: omitting `voice` leaves the
 * stored voice preferences alone, so the Preferences page can save Translation without having to
 * round-trip and re-send Voice (and race a change made in another tab).
 *
 * Within a section it is a whole-object write — the section IS the unit the UI edits.
 */
preferenceRoutes.put("/", async (c) => {
	const session = await requireUser(c);
	const body = (await c.req.json().catch(() => ({}))) as { voice?: unknown; translation?: unknown; timezone?: unknown };
	if (body.voice !== undefined) {
		// Same strict-on-write rule as the per-instance override route.
		const bad = unknownVoiceField((body.voice ?? {}) as Record<string, unknown>);
		if (bad) throw new HttpError(400, bad);
	}
	// Strict on write, and REJECTED rather than coerced (#329). A typo'd zone silently becoming UTC
	// is the same lie #18 refused for cron schedules: the user believes they told us where they are,
	// and every timestamp they read afterwards is quietly wrong by hours.
	const clearsTimezone = body.timezone === null || body.timezone === "";
	if (body.timezone !== undefined && !clearsTimezone && !isValidTimeZone(body.timezone)) {
		throw new HttpError(400, "timezone must be an IANA zone name, e.g. Australia/Sydney");
	}
	const current = await readPreferences(c.env, session.uid);

	const next: AccountPreferences = {
		// Sanitize against the CURRENT stored value, not platform defaults: a partial save must not
		// silently reset the fields it didn't mention.
		voice: body.voice !== undefined ? sanitizeVoiceSettings(body.voice, current.voice) : current.voice,
		translation:
			body.translation !== undefined
				? sanitizeTranslationSettings(body.translation, current.translation)
				: current.translation,
		// `null`/`""` clears it back to UNSET, which is a state a user must be able to return to: it
		// is not "UTC", it is "you were never told", and it is what makes the agent say UTC out loud
		// instead of dressing a guess up as local time.
		timezone: body.timezone === undefined ? current.timezone : clearsTimezone ? undefined : (body.timezone as string),
	};

	await c.env.DB.prepare("UPDATE users SET preferences = ?1 WHERE id = ?2")
		.bind(JSON.stringify(next), session.uid)
		.run();
	return c.json({ preferences: next });
});
