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
}

/** Lenient on read, and unknown ids are dropped — a stored mute for a type we deleted is noise. */
export function sanitizeNotificationPreferences(raw: unknown): NotificationPreferences | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const muted = (raw as { muted?: unknown }).muted;
	if (!Array.isArray(muted)) return { muted: [] };
	const seen = new Set<string>();
	for (const id of muted) if (isKnownNotificationType(id)) seen.add(id);
	return { muted: [...seen] };
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
): boolean {
	if (kind === "alert") return true;
	return !prefs?.muted.includes(type);
}
