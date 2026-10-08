/**
 * The notification policy: which notifications reach the owner, per instance, event and channel (#992).
 *
 * ── What was wrong with the controls before this
 *
 * The account had two axes — a per-type mute and an allow-list of instances — and both applied
 * ONLY to `update`s. That was a deliberate, well-argued floor (`notifications.ts` explains at
 * length why a mute must never hide a run that has stopped and is waiting), but as the only
 * control it leaves the owner unable to say any of the things they actually want to say:
 *
 *   • "this agent, not at all" — the mute is per TYPE, and one type serves many instances;
 *   • "approvals yes, progress no" — both are `apply`, so one mute cannot separate them;
 *   • "in the list but don't buzz my phone" — there was no per-CHANNEL dimension at all;
 *   • "this one agent may interrupt me, including its alerts" — alerts bypassed everything.
 *
 * #991 made that concrete: it added a generic `approval_required` event, and without this module
 * that event would be one more unconfigurable interrupt.
 *
 * ── The model
 *
 * A policy is a list of RULES. A rule selects notifications ({@link NotificationRule.type},
 * {@link NotificationRule.event}, {@link NotificationRule.severity}; an absent selector means
 * "any") and decides one or both CHANNELS (`inapp`, `push`; an absent channel means "inherit").
 * Nothing about applications, coders or deploys appears here: an agent becomes controllable by
 * raising a typed notification, never by this file learning its name.
 *
 * ── Resolution, in one sentence
 *
 * Every rule that MATCHES is ranked by (level, specificity), and for each channel the
 * highest-ranked rule that mentions that channel wins; if none does, the channel falls back to
 * the account baseline (the legacy mute/scope) for `push` and to "always written" for `inapp`.
 *
 * `level` dominates specificity: an instance rule beats an account rule even when the account's
 * is more specific, because the instance IS the more specific statement — the owner said it
 * while looking at that agent. {@link resolveNotificationDelivery} returns the winning rule's
 * origin for every channel, so the UI and MCP can show WHY, not just what: a precedence order
 * nobody can inspect is a precedence order people work around.
 *
 * ── The two invariants this must never break
 *
 *  1. **An alert is still delivered unless the owner said otherwise, explicitly.** The legacy
 *     baseline never silences one, and no rule written by the migration does either — only a
 *     rule the owner authored, naming `severity: "alert"` or matching it unconditionally, can.
 *     `legacyAccountRules` is the proof: every rule it derives carries `severity: "update"`.
 *  2. **The in-app row is a log.** `inapp` defaults to true for everything, and the only way it
 *     becomes false is an explicit rule — which the issue asks for ("unless the owner explicitly
 *     chooses to suppress row creation too") and the console labels as exactly that.
 *
 * PURE — no D1, no Env, no crypto.subtle. Every "do not interrupt this person" decision is
 * testable without a database, which is the same reason `notifications.ts` is pure.
 */

import { NOTIFICATION_TYPES, type NotificationKind, type NotificationPreferences, type NotificationRule, pushAllowedByPreference } from "./notifications.js";

/** Re-exported so callers can name the rule type from the module that resolves it. */
export type { NotificationRule };

/**
 * Where a notification can arrive. A LIST, not a boolean pair, so a third channel (email, Slack,
 * SMS) becomes a member of this union plus a column in the editor — not a reshaping of the stored
 * policy. `inapp` is the durable row in the bell list; `push` is the Web Push interruption.
 */
export const NOTIFICATION_CHANNELS = ["inapp", "push"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface NotificationChannelSpec {
	id: NotificationChannel;
	label: string;
	/** What arriving on this channel actually means for the owner — shown beside the control. */
	description: string;
	/**
	 * May this channel be switched off at all? `inapp` can be, but only deliberately: it is the
	 * audit log, so the console asks twice and the API requires the rule to name it.
	 */
	optional: boolean;
}

export const NOTIFICATION_CHANNEL_SPECS: NotificationChannelSpec[] = [
	{
		id: "inapp",
		label: "In the console",
		description: "The bell list. This is the record of what happened, so it stays on unless you turn it off here on purpose.",
		optional: true,
	},
	{
		id: "push",
		label: "Push to my devices",
		description: "An interruption on every device you have enabled alerts on. Turning it off leaves the notification in the console.",
		optional: true,
	},
];

/** Is a human blocked on this, or is it news? The same two words `notifyUser` already takes. */
export const NOTIFICATION_SEVERITIES = ["update", "alert"] as const;
export type NotificationSeverity = NotificationKind;

/**
 * A rule's SHAPE lives in `notifications.ts` beside the stored document (one-way dependency);
 * what lives here is everything about how one is read, ranked and applied:
 *
 *  • a rule with no selector at all is the level's default ("this instance: nothing at all");
 *  • a rule with no channel decides nothing and is dropped on write, because a stored rule that
 *    cannot change an outcome is a control the owner believes they set.
 */

/** A level's rules, as stored (`users.preferences.notifications.rules`, `config.notifications.rules`). */
export interface NotificationPolicy {
	rules: NotificationRule[];
}

/** Where a rule was written. Dominates specificity in the ranking — see the file docstring. */
export type PolicyLevel = "account" | "instance";

/** What a notification IS, as the resolver needs to see it. Built by `notifyUser` per call. */
export interface NotificationContext {
	type: string;
	severity: NotificationSeverity;
	/** The generic event class, when the producer declared one (#991). */
	event?: string;
	/** The instance it is about, when it is about one. */
	instanceId?: string;
}

/** Why this channel ended up where it did. `source` is the thing a UI shows and a test asserts. */
export interface ChannelDecision {
	allowed: boolean;
	source: PolicyLevel | "baseline" | "default";
	/** The rule that decided it, when a rule did — so the editor can highlight the row. */
	rule?: NotificationRule;
}

export type NotificationDecision = Record<NotificationChannel, ChannelDecision>;

/** Bounds. A policy is a set of choices a person made, not a dump. */
export const RULES_MAX = 60;
const SELECTOR_MAX = 64;

const isSeverity = (v: unknown): v is NotificationSeverity => v === "update" || v === "alert";
const selector = (v: unknown): string | undefined =>
	typeof v === "string" && v.trim().length > 0 && v.trim().length <= SELECTOR_MAX ? v.trim() : undefined;

/**
 * Lenient on read, same split as every other stored document here: a rule we cannot understand is
 * dropped rather than failing the read, and the WRITE path (`routes/notifications-policy.ts`) is
 * what refuses an unknown selector so the owner is never told they set something they did not.
 *
 * A rule that decides no channel is dropped: it would sit in the editor looking like a control.
 */
export function sanitizeNotificationPolicy(raw: unknown): NotificationPolicy | undefined {
	const list = Array.isArray(raw) ? raw : Array.isArray((raw as { rules?: unknown })?.rules) ? (raw as { rules: unknown[] }).rules : null;
	if (!list) return undefined;
	const rules: NotificationRule[] = [];
	for (const entry of list) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const r = entry as Record<string, unknown>;
		const rule: NotificationRule = {};
		const type = selector(r.type);
		if (type) rule.type = type;
		const event = selector(r.event);
		if (event) rule.event = event;
		if (isSeverity(r.severity)) rule.severity = r.severity;
		if (typeof r.inapp === "boolean") rule.inapp = r.inapp;
		if (typeof r.push === "boolean") rule.push = r.push;
		if (rule.inapp === undefined && rule.push === undefined) continue;
		rules.push(rule);
		if (rules.length >= RULES_MAX) break;
	}
	return rules.length ? { rules } : undefined;
}

/** Does this rule apply to this notification? An absent selector matches anything. */
export function ruleMatches(rule: NotificationRule, ctx: NotificationContext): boolean {
	if (rule.type !== undefined && rule.type !== ctx.type) return false;
	if (rule.event !== undefined && rule.event !== ctx.event) return false;
	if (rule.severity !== undefined && rule.severity !== ctx.severity) return false;
	return true;
}

/**
 * How specific a rule is, within its level.
 *
 * The event is the narrowest thing a producer can say about a notification ("this is an approval
 * request"), the type is a whole product area, and the severity cuts across both — so the weights
 * are 4 / 2 / 1 and no combination can tie with a different one. A tie would make the outcome
 * depend on array order, which is not a precedence rule anybody could predict.
 */
export function ruleSpecificity(rule: NotificationRule): number {
	return (rule.event ? 4 : 0) + (rule.type ? 2 : 0) + (rule.severity ? 1 : 0);
}

const LEVEL_RANK: Record<PolicyLevel, number> = { account: 0, instance: 1 };

export interface PolicyInput {
	/** The owner's account baseline — the legacy mute/scope pair, plus any account rules. */
	account?: NotificationPreferences;
	/** The instance's own policy, when the notification is about an instance. */
	instance?: NotificationPolicy;
}

/** Account rules live beside the legacy pair, inside the same stored section. */
const accountRules = (prefs: NotificationPreferences | undefined): NotificationRule[] => prefs?.rules ?? [];

/**
 * The migration, expressed as rules rather than as a schema change (#992).
 *
 * Nothing moves in the database: the legacy `{muted, instances}` pair keeps its meaning and keeps
 * being evaluated by `pushAllowedByPreference` as the BASELINE under every rule. This function
 * exists for the editor — it is how the console and MCP can show an owner what their existing
 * settings already say, in the vocabulary of the new policy, without rewriting their account.
 *
 * Every rule it derives names `severity: "update"`, which is the compatibility guarantee the
 * issue asks for in one line: no existing alert can be silently lost, because nothing here can
 * match an alert.
 */
export function legacyAccountRules(prefs: NotificationPreferences | undefined): NotificationRule[] {
	return (prefs?.muted ?? []).map((type) => ({ type, severity: "update" as const, push: false }));
}

/**
 * Resolve one notification against the policy. The single algorithm, used by the delivery path,
 * the API's effective-state view and MCP — so what the owner is shown is what will happen.
 */
export function resolveNotificationDelivery(ctx: NotificationContext, input: PolicyInput): NotificationDecision {
	const candidates: Array<{ level: PolicyLevel; rule: NotificationRule }> = [
		...accountRules(input.account).map((rule) => ({ level: "account" as const, rule })),
		// Instance rules only exist for a notification that names an instance; a caller that passes
		// one for an account-level notification would be applying someone's "mute this agent" to a
		// résumé-parsed row, which belongs to no agent.
		...(ctx.instanceId ? (input.instance?.rules ?? []).map((rule) => ({ level: "instance" as const, rule })) : []),
	]
		.filter(({ rule }) => ruleMatches(rule, ctx))
		.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || ruleSpecificity(b.rule) - ruleSpecificity(a.rule));

	const decide = (channel: NotificationChannel, fallback: ChannelDecision): ChannelDecision => {
		const hit = candidates.find(({ rule }) => rule[channel] !== undefined);
		return hit ? { allowed: hit.rule[channel] as boolean, source: hit.level, rule: hit.rule } : fallback;
	};

	return {
		// The log is written unless the owner explicitly said not to — invariant 2.
		inapp: decide("inapp", { allowed: true, source: "default" }),
		// The baseline is the pre-#992 behaviour, unchanged and still the floor for anything no rule
		// mentions: the per-type mute, the instance scope, and "an alert always gets through".
		push: decide("push", {
			allowed: pushAllowedByPreference(input.account, ctx.type, ctx.severity, ctx.instanceId),
			source: "baseline",
		}),
	};
}

/** One cell of the effective-state view: a (type, severity) pair as it will actually behave. */
export interface EffectiveRow {
	type: string;
	severity: NotificationSeverity;
	event?: string;
	inapp: ChannelDecision;
	push: ChannelDecision;
}

/**
 * The whole visible surface for one instance (or the account), resolved.
 *
 * The console does not compute this: a second implementation of the precedence order is a second
 * answer, and the one the owner reads would be the one that is wrong. `types` and `events` come
 * from the server's own vocabularies, so a new notification type or attention event appears here
 * by existing.
 */
export function effectiveNotificationMatrix(
	vocab: { types: string[]; events?: string[] },
	input: PolicyInput,
	instanceId?: string,
): EffectiveRow[] {
	const rows: EffectiveRow[] = [];
	for (const type of vocab.types) {
		for (const severity of NOTIFICATION_SEVERITIES) {
			const ctx: NotificationContext = { type, severity, instanceId };
			const d = resolveNotificationDelivery(ctx, input);
			rows.push({ type, severity, inapp: d.inapp, push: d.push });
		}
	}
	for (const event of vocab.events ?? []) {
		// An event is severity-independent in the editor: the owner says "approvals", and the
		// producer decides how urgent one is. Resolved as the `alert` it is raised as (#991 — every
		// owner-attention event is an alert), which is the row that actually fires.
		const ctx: NotificationContext = { type: "", severity: "alert", event, instanceId };
		const d = resolveNotificationDelivery({ ...ctx }, input);
		rows.push({ type: "", severity: "alert", event, inapp: d.inapp, push: d.push });
	}
	return rows;
}

/** "Everything off for this instance", as a policy — the control the issue asks for by name. */
export const allOffPolicy = (): NotificationPolicy => ({ rules: [{ inapp: false, push: false }] });

/** "Push off, keep the log" — the safer half of the same control, and the console's default off. */
export const pushOffPolicy = (): NotificationPolicy => ({ rules: [{ push: false }] });

/**
 * Is this selector one the server knows? Used by the WRITE path only.
 *
 * An unknown TYPE is refused, because the type vocabulary is closed and a typo would be a rule
 * that silently never matches. An event is checked against the vocabulary the caller passes
 * (owner-attention's, today) for the same reason.
 */
export function unknownSelector(rule: NotificationRule, knownEvents: string[]): string | undefined {
	const { type, event } = rule;
	// `NOTIFICATION_TYPES.some` rather than `isKnownNotificationType`: that guard is declared
	// `id is string`, so TypeScript narrows the NEGATIVE branch to `never` and the error message
	// below cannot read the value it is about.
	if (type !== undefined && !NOTIFICATION_TYPES.some((t) => t.id === type)) return `unknown notification type: ${type.slice(0, 40)}`;
	if (event !== undefined && !knownEvents.includes(event)) return `unknown notification event: ${event.slice(0, 40)}`;
	return undefined;
}
