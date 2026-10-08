/**
 * The per-instance notification policy (#992) — read, write, and "restore inherited".
 *
 * Shape follows the behaviour routes (`instances-behaviour.ts`) for the reason that worked there:
 * the stored object is SPARSE — only what the owner actually decided — so a GET cannot return a
 * merged blob and still be honest about what is inherited. It therefore returns three things:
 * the instance's own rules, the account baseline they sit over, and the RESOLVED effective state
 * per notification type, severity and channel, each with the level that decided it.
 *
 * That `effective` array is the whole point of the issue's "inheritance/effective-state
 * visibility" requirement, and the server computes it: the console asking for the rules and
 * applying the precedence order itself would be a second implementation of the precedence order,
 * and the one the owner reads would be the one that is wrong.
 */
import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { patchInstanceConfig, removeInstanceConfigKey } from "../lib/instance-config.js";
import {
	type NotificationRule,
	NOTIFICATION_CHANNEL_SPECS,
	NOTIFICATION_SEVERITIES,
	RULES_MAX,
	allOffPolicy,
	effectiveNotificationMatrix,
	legacyAccountRules,
	sanitizeNotificationPolicy,
	unknownSelector,
} from "../lib/notification-policy.js";
import { NOTIFICATION_TYPES } from "../lib/notifications.js";
import { OWNER_ATTENTION_EVENTS } from "../lib/owner-attention.js";
import { parseAccountPreferences } from "../lib/preferences.js";
import { readInstanceNotificationPolicy } from "./push.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

const eventIds = (): string[] => OWNER_ATTENTION_EVENTS.map((e) => e.id);

async function accountNotifications(env: Env, userId: string) {
	const row = await env.DB.prepare("SELECT preferences FROM users WHERE id = ?1").bind(userId).first<{ preferences: string | null }>();
	return parseAccountPreferences(row?.preferences).notifications;
}

/**
 * Strict on write, like every other settings route: a rule we cannot evaluate is REFUSED, never
 * dropped. A silently discarded rule is worse here than anywhere else on the platform — the owner
 * believes they turned an interruption off, and the only evidence they get is being interrupted.
 */
export function validateRules(raw: unknown, knownEvents: string[]): NotificationRule[] {
	if (!Array.isArray(raw)) throw new HttpError(400, "rules must be an array");
	if (raw.length > RULES_MAX) throw new HttpError(400, `at most ${RULES_MAX} rules`);
	const out: NotificationRule[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new HttpError(400, "each rule must be an object");
		const r = entry as Record<string, unknown>;
		const unknownKey = Object.keys(r).find((k) => !["type", "event", "severity", "inapp", "push"].includes(k));
		if (unknownKey) throw new HttpError(400, `unknown rule field: ${unknownKey.slice(0, 40)}`);
		if (r.severity !== undefined && r.severity !== "update" && r.severity !== "alert") {
			throw new HttpError(400, `severity must be one of ${NOTIFICATION_SEVERITIES.join(", ")}`);
		}
		for (const ch of NOTIFICATION_CHANNEL_SPECS) {
			if (r[ch.id] !== undefined && typeof r[ch.id] !== "boolean") throw new HttpError(400, `${ch.id} must be true or false`);
		}
		if (r.inapp === undefined && r.push === undefined) throw new HttpError(400, "each rule must decide `inapp` or `push`");
		const single = sanitizeNotificationPolicy([r]);
		const rule = single?.rules[0];
		if (!rule) throw new HttpError(400, "each rule must decide `inapp` or `push`");
		const bad = unknownSelector(rule, knownEvents);
		if (bad) throw new HttpError(400, bad);
		out.push(rule);
	}
	return out;
}

export function registerInstanceNotificationRoutes(router: Hono<{ Bindings: Env }>): void {
	/**
	 * The vocabularies a write needs, served rather than duplicated in the console build — the same
	 * reason `behaviour-schema` and `notificationTypes` are served. A new notification type, event
	 * or CHANNEL gets its controls by existing here.
	 */
	router.get("/notification-vocabulary", (c) =>
		c.json({
			types: NOTIFICATION_TYPES,
			events: OWNER_ATTENTION_EVENTS,
			channels: NOTIFICATION_CHANNEL_SPECS,
			severities: NOTIFICATION_SEVERITIES,
		}),
	);

	/** This instance's rules, what they inherit from, and the resolved state of every row. */
	router.get("/:instanceId/notifications", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const account = await accountNotifications(c.env, session.uid);
		const instance = await readInstanceNotificationPolicy(c.env, instanceId, session.uid);
		return c.json({
			instanceId,
			/** Only what the owner set here. Empty means "inherits the account" — a real state. */
			rules: instance?.rules ?? [],
			inherited: {
				rules: account?.rules ?? [],
				/** The pre-#992 account axes, shown as the rules they are equivalent to. */
				legacy: legacyAccountRules(account),
				muted: account?.muted ?? [],
				instances: account?.instances ?? [],
			},
			effective: effectiveNotificationMatrix({ types: NOTIFICATION_TYPES.map((t) => t.id), events: eventIds() }, { account, instance }, instanceId),
		});
	});

	/**
	 * Replace this instance's rules. The whole list, because the list IS the unit the editor edits —
	 * a per-rule patch would need rule ids, and an id for "apply/update/push off" is a worse name
	 * for it than the rule itself.
	 *
	 * `{"allOff": true}` is the issue's named control, written as the one rule that expresses it so
	 * that the stored policy says what it does and the editor can show it like any other rule.
	 */
	router.put("/:instanceId/notifications", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as { rules?: unknown; allOff?: unknown };
		if (body.allOff !== undefined && typeof body.allOff !== "boolean") throw new HttpError(400, "allOff must be true or false");
		if (body.allOff === true && body.rules !== undefined) throw new HttpError(400, "send either allOff or rules, not both");
		const rules = body.allOff === true ? allOffPolicy().rules : validateRules(body.rules ?? [], eventIds());
		// Patch one key, never the whole config blob (#231): a notification policy saved in one tab
		// must not clobber a setting saved in another.
		const ok = await patchInstanceConfig(c.env, instanceId, session.uid, "notifications", rules.length ? { rules } : null);
		if (!ok) throw new HttpError(404, "Instance not found");
		const account = await accountNotifications(c.env, session.uid);
		const instance = sanitizeNotificationPolicy({ rules });
		return c.json({
			instanceId,
			rules: instance?.rules ?? [],
			effective: effectiveNotificationMatrix({ types: NOTIFICATION_TYPES.map((t) => t.id), events: eventIds() }, { account, instance }, instanceId),
		});
	});

	/** Restore inherited: drop this instance's rules entirely and fall back to the account. */
	router.delete("/:instanceId/notifications", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		await removeInstanceConfigKey(c.env, instanceId, session.uid, "notifications");
		const account = await accountNotifications(c.env, session.uid);
		return c.json({
			instanceId,
			rules: [],
			restored: true,
			effective: effectiveNotificationMatrix({ types: NOTIFICATION_TYPES.map((t) => t.id), events: eventIds() }, { account }, instanceId),
		});
	});
}
