/**
 * The floor under every notification (#361), and the vocabulary a mute is expressed in (#360).
 *
 * `notifyUser` is the single funnel every notification passes through, and until this it had
 * nothing under it: no coalescing, no rate limit, no recent-duplicate check. The push `tag`
 * made that look solved and did not — a web-push `tag` collapses the OS tray *visually*, so N
 * identical notifications show as one entry while each still fires its own alert and sound.
 * The tray is the only surface that hid the duplication, and it is the one nobody audits.
 *
 * PURE — no D1, no Env, no crypto.subtle. Every decision that says "do not interrupt this
 * person" is testable without a database, and the same rules apply to the account route and
 * the send path.
 */

/**
 * Is a human blocked on this, or is it news?
 *
 * The platform already draws this line on the board — a `needs_human` card is a different
 * object from a completed run — and the notification layer had no equivalent. It matters here
 * because it decides what a mute is allowed to hide: an `alert` is a run that has STOPPED and
 * is waiting for you, so silencing it does not reduce noise, it strands work.
 *
 * It is per-CALL, not per-type, because the existing types are mixed: `coding` carries both
 * "🙋 Coder needs you" and "✅ Coder finished", `apply` both a CAPTCHA handoff and "résumé
 * parsed". A per-type flag would have to be wrong about one of them.
 */
export type NotificationKind = "alert" | "update";

/**
 * One rule of the notification policy (#992): selectors narrow WHAT it is about, the channel
 * fields decide what happens, and an absent field means "any" / "inherit" respectively.
 *
 * Declared HERE, with the rest of the stored notification document, so the dependency runs one
 * way: this module owns the shape, `notification-policy.ts` owns the resolution and the
 * field-level sanitization, and nothing imports backwards. The same split keeps this file pure.
 */
export interface NotificationRule {
	/** A notification type id (`apply`, `coding`, `ci`, …). Absent = any type. */
	type?: string;
	/** A generic event class — `approval_required` and the rest of #991's vocabulary. Absent = any. */
	event?: string;
	severity?: NotificationKind;
	/** May it be written to the bell list? Absent = inherit. */
	inapp?: boolean;
	/** May it interrupt the owner's devices? Absent = inherit. */
	push?: boolean;
}

export interface NotificationTypeSpec {
	/** The `type` string callers already pass, and the push `tag`. */
	id: string;
	label: string;
	/** What muting this actually stops — shown next to the control, not marketing prose. */
	description: string;
	/** True when this type can also raise an `alert`, i.e. a mute here is partial by design. */
	alerts: boolean;
}

/**
 * Every type `notifyUser` is called with, as data.
 *
 * The console renders its mute controls from this list (served by `GET /v1/preferences`), so a
 * new notification type gets a control by being added here rather than by editing the page —
 * the same reason the behaviour table and the capability registry are data.
 */
export const NOTIFICATION_TYPES: NotificationTypeSpec[] = [
	{
		id: "apply",
		label: "Job applications",
		description: "Progress on an application run, and your résumé being parsed.",
		alerts: true,
	},
	{
		id: "coding",
		label: "Coder",
		description: "A coding session finishing or stopping.",
		alerts: true,
	},
	{
		id: "deploy",
		label: "Deploys",
		description: "A deploy of one of your repos going out, or failing.",
		alerts: false,
	},
	{
		// Live since the CI-health sweep shipped (`lib/repo-ci-health.ts:353` calls notifyUser with
		// it) and missing from this list, which meant `isKnownNotificationType("ci")` was false — so
		// a mute for it could not even be SAVED (the preferences route refuses an unknown id) and
		// the console had no control to offer. #992 is "the owner can control every notification
		// received"; a type nobody can name is the one hole that makes that untrue by construction.
		id: "ci",
		label: "Build checks",
		description: "A repo's checks going red or recovering, separately from a deploy.",
		alerts: false,
	},
	{
		id: "loop",
		label: "Autonomous runs",
		description: "A loop reaching the end of what it can do on its own.",
		alerts: true,
	},
	{
		id: "trigger",
		label: "Scheduled runs",
		description: "A scheduled run being skipped because your machine was not ready.",
		alerts: false,
	},
	{
		id: "secure-input",
		label: "Secure inputs",
		description: "An agent waiting for you to enter a secret value (#934).",
		alerts: true,
	},
	{
		id: "local-browser",
		label: "Browser research",
		description: "A research run pausing for you — a new site to allow, a captcha, or a sign-in (#946).",
		alerts: true,
	},
	{
		id: "subscribe",
		label: "New subscribers",
		description: "Someone subscribing to an agent you publish.",
		alerts: false,
	},
];

export function isKnownNotificationType(id: unknown): id is string {
	return typeof id === "string" && NOTIFICATION_TYPES.some((t) => t.id === id);
}

/**
 * How long one event stays "already sent".
 *
 * Minutes, not hours: this bounds a MALFUNCTION, it is not a policy about how often the
 * product may speak. A window measured in hours would start swallowing legitimate repeats and
 * become the next bug; ten minutes is longer than any retry/sweep loop in this codebase
 * (the deploy sweep is per-minute, the handoff polls are 5s) and shorter than any interval a
 * person would consider "again".
 */
export const DUPLICATE_WINDOW_MINUTES = 10;

/** FNV-1a, seeded twice so the concatenated digest has ~64 bits and collisions stay theoretical. */
function fnv1a(input: string, seed: number): string {
	let h = seed >>> 0;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/**
 * The identity of the EVENT a notification is about — what "I have already sent this" means.
 *
 * Deliberately NOT a comparison of the title. Prose is not identity twice over:
 *
 *  - the same event produces different prose. One push to `ProAgentStore/platform` starts
 *    several workflows, each with its own per-workflow run number, so `✅ Deployed #412` and
 *    `✅ Deployed #88` are the same deploy of the same commit wearing two titles — a title
 *    compare sees two events and buzzes twice (#359);
 *  - different events produce the same prose. Two agents both stuck on a CAPTCHA on the same
 *    site would collide, and the second — a run genuinely waiting on a human — would be the
 *    one dropped.
 *
 * So a caller that knows what its event IS passes `event` (a run's commit sha, a session's
 * handoff, a trigger id) and the key is stable across every copy edit to the title. The
 * derived fallback over `title|body` exists only so an unconverted caller still has a floor —
 * it is the weaker key, and it is the reason `event` is worth passing.
 *
 * Hashed rather than stored raw so the column is bounded and indexable regardless of what a
 * caller puts in it. This is a dedup key, not a security boundary; a non-cryptographic hash is
 * the right tool and keeps the function synchronous and pure.
 */
export function notificationDedupeKey(type: string, event: string | undefined, title: string, body: string): string {
	const material = event?.trim() ? `e\u0000${event.trim()}` : `p\u0000${title}\u0000${body}`;
	const scoped = `${type}\u0000${material}`;
	return `${type.slice(0, 24)}:${fnv1a(scoped, 0x811c9dc5)}${fnv1a(scoped, 0x9e3779b9)}`;
}

/**
 * Per-type mute, stored on the account (`users.preferences.notifications`) beside timezone and
 * voice — a property of the PERSON, like everything else on that page, not of an agent.
 */
export interface NotificationPreferences {
	/** Types whose *updates* do not raise a push. Never applies to an `alert`. */
	muted: string[];
	/**
	 * Instances whose *updates* may raise a push (#784). Absent or empty means every instance —
	 * the default, and the state a user returns to by clearing the list. Never applies to an
	 * `alert`, and never to a row that carries no instance (a résumé parsed, a new subscriber):
	 * a scope can only exclude what it can name.
	 */
	instances?: string[];
	/**
	 * The per-event, per-channel policy (#992) — the general mechanism, layered OVER the two
	 * legacy axes above rather than replacing them.
	 *
	 * The pair stays exactly as it was and keeps being evaluated as the baseline, which is what
	 * makes the migration a no-op: an account that never writes a rule behaves identically. A rule
	 * is the only thing that can decide a channel explicitly, and the only thing that can touch an
	 * `alert`. Resolution lives in `notification-policy.ts`, which is also where the precedence
	 * order is written down.
	 */
	rules?: NotificationRule[];
}

/** Bounds on the instance scope: an id is opaque but not unbounded, and a list is a choice, not a dump. */
const INSTANCE_ID_MAX = 100;
const INSTANCE_SCOPE_MAX = 200;

/** Lenient on read, and unknown ids are dropped — a stored mute for a type we deleted is noise. */
export function sanitizeNotificationPreferences(raw: unknown): NotificationPreferences | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const { muted, instances } = raw as { muted?: unknown; instances?: unknown };
	const seen = new Set<string>();
	if (Array.isArray(muted)) for (const id of muted) if (isKnownNotificationType(id)) seen.add(id);
	const scope = new Set<string>();
	if (Array.isArray(instances)) {
		for (const id of instances) {
			if (typeof id === "string" && id.length > 0 && id.length <= INSTANCE_ID_MAX) scope.add(id);
			if (scope.size >= INSTANCE_SCOPE_MAX) break;
		}
	}
	// The policy rides in the same section (#992). Only its SHAPE is checked here — an array of
	// objects — because the field-level sanitizer belongs with the resolver that has to understand
	// them, and `parseAccountPreferences` runs it on every read. A non-array is dropped rather
	// than stored: `resolveNotificationDelivery` maps over this list.
	const rawRules = (raw as { rules?: unknown }).rules;
	const policyRules = Array.isArray(rawRules)
		? (rawRules.filter((r) => !!r && typeof r === "object" && !Array.isArray(r)) as NotificationRule[])
		: undefined;
	// The key is absent, not `[]`, when there is no scope: "every instance" is the ABSENCE of a
	// choice, and a stored `instances: []` would read as a choice that happens to be empty.
	return {
		muted: [...seen],
		...(scope.size ? { instances: [...scope] } : {}),
		...(policyRules?.length ? { rules: policyRules } : {}),
	};
}

/**
 * May this notification interrupt the user?
 *
 * **An `alert` is never muted, and the UI says so.** A mute that can hide an actionable
 * notification is how someone misses a run blocked waiting on them — the failure it causes is
 * silent, open-ended and indistinguishable from the agent being slow, which is strictly worse
 * than the noise it was meant to fix. Muting `coding` therefore stops "✅ Coder finished" and
 * keeps "🙋 Coder needs you"; that is not a leak, it is the whole distinction, and
 * `NotificationTypeSpec.alerts` is what lets the control say it up front rather than surprise
 * someone later.
 *
 * The in-app row is written either way. Mute bounds the INTERRUPTION; the bell list is a log
 * and stays complete — the same split #176 made when it suppressed the OS banner for a visible
 * console tab and still forwarded the payload so the badge updated.
 */
export function pushAllowedByPreference(
	prefs: NotificationPreferences | undefined,
	type: string,
	kind: NotificationKind,
	/** The instance the notification is about, when the caller has one (#784). */
	instanceId?: string,
): boolean {
	if (kind === "alert") return true;
	if (prefs?.muted.includes(type)) return false;
	// The instance scope (#784): an update about an instance outside the chosen set does not
	// interrupt. A row with no instance cannot be outside a set of instances, so it passes —
	// the scope narrows what it can name and nothing else.
	if (instanceId && prefs?.instances?.length && !prefs.instances.includes(instanceId)) return false;
	return true;
}
