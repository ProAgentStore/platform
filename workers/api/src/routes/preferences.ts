/**
 * Account preferences — how YOU speak, hear and read, across every agent (#211).
 *
 * Voice and translation used to live only on `agent_instances.config`, so both had to be configured
 * once per agent, and a new subscription seeded neither. Neither is a property of an agent.
 *
 * An agent can still differ: `PUT /v1/instances/:id/voice-settings` writes a per-instance override,
 * and `DELETE` clears it back to these defaults. Every clamp and the precedence chain live in the
 * pure `lib/preferences.ts`, shared with those routes so the two can't drift.
 */
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import {
	parseAccountPreferences,
	sanitizeTranslationSettings,
	sanitizeVoiceSettings,
	unknownVoiceField,
	type AccountPreferences,
} from "../lib/preferences.js";
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
	return c.json({ preferences: await readPreferences(c.env, session.uid) });
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
	const body = (await c.req.json().catch(() => ({}))) as { voice?: unknown; translation?: unknown };
	if (body.voice !== undefined) {
		// Same strict-on-write rule as the per-instance override route.
		const bad = unknownVoiceField((body.voice ?? {}) as Record<string, unknown>);
		if (bad) throw new HttpError(400, bad);
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
	};

	await c.env.DB.prepare("UPDATE users SET preferences = ?1 WHERE id = ?2")
		.bind(JSON.stringify(next), session.uid)
		.run();
	return c.json({ preferences: next });
});
