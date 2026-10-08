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
import { applyDefaultCodingEngineToIdle } from "../lib/coding-default-engine-apply.js";
import { DEFAULT_ENGINES } from "../lib/coding-engines.js";
import { isValidTimeZone } from "../lib/cron-time.js";
import { isKnownNotificationType, NOTIFICATION_TYPES, sanitizeNotificationPreferences } from "../lib/notifications.js";
import { NOTIFICATION_CHANNEL_SPECS, NOTIFICATION_SEVERITIES, effectiveNotificationMatrix } from "../lib/notification-policy.js";
import { attentionEventSpec, OWNER_ATTENTION_EVENTS, sanitizeOwnerAttentionPreferences } from "../lib/owner-attention.js";
import { validateRules } from "./instances-notifications.js";
import {
	parseAccountPreferences,
	sanitizeCodingPreferences,
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
	//
	// `notificationTypes` rides along for the same reason and is served rather than hardcoded in
	// the console: the type table is the vocabulary the mute is expressed in, and a new type
	// should get a control by being added to `lib/notifications.ts` — the same reason
	// `GET /v1/instances/behaviour-schema` serialises the behaviour table instead of the page
	// carrying a second copy of it.
	return c.json({
		preferences: await readPreferences(c.env, session.uid),
		languages: TRANSLATION_LANGUAGES,
		notificationTypes: NOTIFICATION_TYPES,
		// #991: the owner-attention vocabulary, served for the same reason — a new event gets its
		// control by being added to `lib/owner-attention.ts`, not by editing the page.
		attentionEvents: OWNER_ATTENTION_EVENTS,
		// #992: the channels a rule can decide, and the severities it can select. Served for the
		// same reason as the two lists above — a new channel gets a column in the editor by being
		// added to `lib/notification-policy.ts`, not by editing the page.
		notificationChannels: NOTIFICATION_CHANNEL_SPECS,
		notificationSeverities: NOTIFICATION_SEVERITIES,
		// The account's own rules RESOLVED (#992), with no instance in scope — so the Preferences
		// page shows the same effective state, computed by the same algorithm, as an instance's
		// editor does. The console never resolves precedence itself.
		notificationEffective: effectiveNotificationMatrix(
			{ types: NOTIFICATION_TYPES.map((t) => t.id), events: OWNER_ATTENTION_EVENTS.map((e) => e.id) },
			{ account: (await readPreferences(c.env, session.uid)).notifications },
		),
		codingEngineOptions: DEFAULT_ENGINES.map((e) => ({ id: e.id, label: e.label })),
	});
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
	const body = (await c.req.json().catch(() => ({}))) as {
		voice?: unknown;
		translation?: unknown;
		coding?: unknown;
		timezone?: unknown;
		notifications?: unknown;
		attention?: unknown;
	};
	// Strict on write, like `notifications` below: an event we do not know, or one whose push is not
	// optional, must be refused rather than dropped — a silently ignored save leaves the owner
	// believing they turned something off (#991).
	if (body.attention !== undefined) {
		const pushOff = (body.attention as { pushOff?: unknown } | null)?.pushOff;
		if (!body.attention || typeof body.attention !== "object" || Array.isArray(body.attention) || (pushOff !== undefined && !Array.isArray(pushOff))) {
			throw new HttpError(400, "attention must be an object with a `pushOff` array");
		}
		const bad = (pushOff ?? []).find((id: unknown) => !attentionEventSpec(typeof id === "string" ? id : "")?.pushOptional);
		if (bad !== undefined) throw new HttpError(400, `unknown or non-optional attention event: ${String(bad).slice(0, 40)}`);
	}
	// Strict on write, like the timezone below: silently dropping a mute for a type we do not
	// know leaves the user believing they turned something off. The sanitizer that runs on READ
	// is lenient on purpose (it parses rows written by older code); a save is not.
	if (body.notifications !== undefined) {
		// The policy rules ride inside the same section (#992), and are validated by the same
		// strict-on-write rule the mute list has had since #360: an unknown selector is refused,
		// because a rule that silently never matches is an interruption the owner believes they
		// turned off. One validator, shared with the per-instance route.
		const rules = (body.notifications as { rules?: unknown } | null)?.rules;
		if (rules !== undefined) validateRules(rules, OWNER_ATTENTION_EVENTS.map((e) => e.id));
		const muted = (body.notifications as { muted?: unknown } | null)?.muted;
		if (!body.notifications || typeof body.notifications !== "object" || (muted !== undefined && !Array.isArray(muted))) {
			throw new HttpError(400, "notifications must be an object with a `muted` array");
		}
		const unknown = (muted ?? []).find((id: unknown) => !isKnownNotificationType(id));
		if (unknown !== undefined) {
			throw new HttpError(400, `unknown notification type: ${String(unknown).slice(0, 40)}`);
		}
		// The instance scope (#784): a list of ids, or absent. Not validated against ownership —
		// an id that is not yours matches no notification you will ever receive, so it is inert
		// rather than dangerous — but its SHAPE is, for the same reason `muted`'s is: a silently
		// dropped scope leaves the user believing they narrowed something.
		const instances = (body.notifications as { instances?: unknown }).instances;
		if (instances !== undefined && (!Array.isArray(instances) || instances.some((id) => typeof id !== "string"))) {
			throw new HttpError(400, "notifications.instances must be an array of instance ids");
		}
	}
	if (body.voice !== undefined) {
		// Same strict-on-write rule as the per-instance override route.
		const bad = unknownVoiceField((body.voice ?? {}) as Record<string, unknown>);
		if (bad) throw new HttpError(400, bad);
	}
	if (body.coding !== undefined) {
		if (!body.coding || typeof body.coding !== "object" || Array.isArray(body.coding)) {
			throw new HttpError(400, "coding must be an object");
		}
		const engineId = (body.coding as { defaultEngineId?: unknown }).defaultEngineId;
		const clears = engineId === null || engineId === "";
		if (!clears && typeof engineId !== "string") throw new HttpError(400, "coding.defaultEngineId must be an engine id");
		if (!clears && !DEFAULT_ENGINES.some((e) => e.id === engineId)) {
			throw new HttpError(400, `unknown coding engine: ${String(engineId).slice(0, 40)}`);
		}
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
		coding: body.coding !== undefined ? sanitizeCodingPreferences(body.coding, current.coding) : current.coding,
		// `null`/`""` clears it back to UNSET, which is a state a user must be able to return to: it
		// is not "UTC", it is "you were never told", and it is what makes the agent say UTC out loud
		// instead of dressing a guess up as local time.
		timezone: body.timezone === undefined ? current.timezone : clearsTimezone ? undefined : (body.timezone as string),
		notifications:
			body.notifications === undefined
				? current.notifications
				: sanitizeNotificationPreferences(body.notifications),
		// The OTHER axis (#991): `notifications` mutes a product area, `attention` mutes a KIND of
		// attention ("don't push me when something needs approving") across every agent. Same
		// section-level patch rule — omitting it leaves the stored channel controls alone.
		attention:
			body.attention === undefined ? current.attention : sanitizeOwnerAttentionPreferences(body.attention),
	};

	await c.env.DB.prepare("UPDATE users SET preferences = ?1 WHERE id = ?2")
		.bind(JSON.stringify(next), session.uid)
		.run();
	return c.json({ preferences: next });
});

preferenceRoutes.post("/coding/default-engine/apply", async (c) => {
	const session = await requireUser(c);
	return c.json(await applyDefaultCodingEngineToIdle(c.env, session.uid));
});
