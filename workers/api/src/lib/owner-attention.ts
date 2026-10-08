/**
 * Owner attention as a typed, configurable event — for any agent or workflow (#991).
 *
 * ── Why this is generic and not an apply-specific push
 *
 * The need surfaced on a job application: a real SEEK listing whose final control is a genuine
 * one-click apply, which the Runner refused under `fill_and_review` (correctly — it would have sent
 * the application). The run ended, the application closed `blocked`, and the record said "approve
 * this application to let it be sent". Nothing told the owner. A notification bolted onto the apply
 * pipeline would have fixed that one case and left the next one — a coding Pilot that needs a
 * decision, a research run holding a site, a connector waiting on a value — to bolt on its own.
 *
 * So the unit here is **the kind of attention needed**, declared as data, with the apply case as its
 * first consumer. `OWNER_ATTENTION_EVENTS` is the vocabulary a reader (and the console's controls)
 * work from, and {@link requestOwnerAttention} is the one call: event + the typed subject it deep
 * links to + what it is ABOUT + the prose.
 *
 * ── What it deliberately does NOT reinvent
 *
 * Delivery, dedupe, preferences and the in-app list already exist and are good: `notifyUser`
 * (`routes/push.ts`) writes the durable row, honours the account's per-type and per-instance mutes,
 * suppresses a repeat of the same event inside `DUPLICATE_WINDOW_MINUTES`, and treats push as
 * best-effort over a row that is always written. This layer sits ON that — it adds the typed event,
 * the stable identity, the per-event channel control and a TRUTHFUL outcome, and changes nothing
 * about how an existing caller behaves.
 *
 * ── Truthful degradation
 *
 * The outcome says what actually happened to each channel: `recorded` is the in-app row (the log,
 * always attempted), and `push` is one of `sent` | `muted` | `deduped` | `unavailable`. A caller
 * that reports "the owner was notified" when no push could be delivered is the failure mode this
 * exists to avoid — the owner is not told, and the system says they were.
 */
import { type DeepLink, deepLinkFor, type NotificationSubject } from "./console-links.js";
import { type NotificationPreferences, notificationDedupeKey } from "./notifications.js";
import type { Env } from "../types.js";

/** The kinds of attention an agent can ask for. DATA — the console renders its controls from this. */
export interface OwnerAttentionEventSpec {
	id: string;
	label: string;
	/** What the owner is being asked to do, in their words — shown beside the control. */
	description: string;
	/**
	 * `alert` means a human is BLOCKED on this: it is never muted by a per-type preference, because
	 * a mute that can hide a blocked run causes a silent, open-ended failure (`notifications.ts`
	 * says why at length). An `update` is informational and mutable.
	 */
	kind: "alert" | "update";
	/** May the owner turn this event's PUSH off specifically? The in-app row is never optional. */
	pushOptional: boolean;
}

export const OWNER_ATTENTION_EVENTS: OwnerAttentionEventSpec[] = [
	{
		id: "approval_required",
		label: "Approval needed",
		description: "A run stopped at something it may not do without your say-so — a submission, a purchase, an irreversible action. It is waiting, and nothing has been sent.",
		kind: "alert",
		pushOptional: true,
	},
	{
		id: "input_required",
		label: "A value is needed",
		description: "A run needs something only you have — an answer, a credential, a file — and refuses to invent it.",
		kind: "alert",
		pushOptional: true,
	},
	{
		id: "blocker_required",
		label: "Something is in the way",
		description: "A run hit a captcha, a sign-in or an access block that a person has to clear in the browser on your machine.",
		kind: "alert",
		pushOptional: true,
	},
	{
		id: "decision_required",
		label: "A choice is needed",
		description: "A run has finished what it can do on its own and is waiting for you to choose what happens next.",
		kind: "alert",
		pushOptional: true,
	},
];

export type OwnerAttentionEvent = (typeof OWNER_ATTENTION_EVENTS)[number]["id"];

export const attentionEventSpec = (id: string): OwnerAttentionEventSpec | undefined => OWNER_ATTENTION_EVENTS.find((e) => e.id === id);
export const isOwnerAttentionEvent = (id: unknown): id is OwnerAttentionEvent => typeof id === "string" && OWNER_ATTENTION_EVENTS.some((e) => e.id === id);

/**
 * What the attention is ABOUT — the identity a repeat is recognised by.
 *
 * `state` is what makes the dedupe honest rather than permanent: the same application blocked at
 * the same state version is ONE event however many times a sweep notices it, and the same
 * application blocked again after the owner retried is a NEW one. Without it a second, genuine
 * request would be swallowed as a duplicate; with a timestamp instead of a state, every sweep tick
 * would be a fresh buzz. Neither is what an owner wants.
 */
export interface OwnerAttentionAbout {
	/** A short noun for the thing: `application`, `run`, `session`, `request`. */
	kind: string;
	id: string;
	/** The state the request was raised at — a version, a status, a checkpoint id. */
	state?: string | number;
}

export interface OwnerAttentionRequest {
	event: OwnerAttentionEvent;
	userId: string;
	/** The agent this is about — carried so the account's per-instance scope can apply. */
	instanceId: string;
	/** Where the owner acts on it. Typed, so it cannot be a URL that does not resolve (#894). */
	subject: NotificationSubject;
	about: OwnerAttentionAbout;
	title: string;
	body: string;
	/**
	 * Which existing notification type this rides under (`apply`, `coding`, `local-browser`, …), so
	 * the account's current mute controls keep working unchanged. The EVENT says what kind of
	 * attention it is; the type says which part of the product it came from.
	 */
	notificationType: string;
}

export type PushOutcome = "sent" | "muted" | "deduped" | "unavailable";

export interface OwnerAttentionOutcome {
	event: OwnerAttentionEvent;
	/** The in-app row — the log, which is written whatever happens to the push. */
	recorded: boolean;
	push: PushOutcome;
	/** The identity this was deduped on, so a caller can log or assert it. */
	key: string;
	url: DeepLink;
	/** One sentence a caller may surface or log; never "notified" when nothing was delivered. */
	detail: string;
}

/** Per-user channel control for attention events, beside the existing mutes (`users.preferences`). */
export interface OwnerAttentionPreferences {
	/** Event ids whose PUSH the owner has turned off. The in-app row is never optional. */
	pushOff?: string[];
}

const EVENT_SCOPE_MAX = 20;

/** Lenient on read; an unknown or non-optional event id is dropped rather than stored. */
export function sanitizeOwnerAttentionPreferences(raw: unknown): OwnerAttentionPreferences | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const { pushOff } = raw as { pushOff?: unknown };
	const out = new Set<string>();
	if (Array.isArray(pushOff)) {
		for (const id of pushOff) {
			const spec = typeof id === "string" ? attentionEventSpec(id) : undefined;
			// Only an event that DECLARES its push optional can be turned off — otherwise a stored
			// preference would quietly disable a channel the product says it does not disable.
			if (spec?.pushOptional) out.add(spec.id);
			if (out.size >= EVENT_SCOPE_MAX) break;
		}
	}
	return out.size ? { pushOff: [...out] } : undefined;
}

/** May this event's push reach the owner? PURE — the control, without the delivery. */
export function attentionPushAllowed(prefs: OwnerAttentionPreferences | undefined, event: string): boolean {
	const spec = attentionEventSpec(event);
	if (!spec) return true;
	if (!spec.pushOptional) return true;
	return !(prefs?.pushOff ?? []).includes(spec.id);
}

/** The stable identity of one attention request. PURE, and the reason a sweep can re-notice safely. */
export function attentionKey(event: string, about: OwnerAttentionAbout): string {
	const state = about.state === undefined || about.state === null ? "" : String(about.state);
	return `attention:${event}:${about.kind}:${about.id}${state ? `:${state}` : ""}`;
}

/** The sentence the outcome carries — it never claims a delivery that did not happen. */
export function attentionDetail(event: string, push: PushOutcome, recorded: boolean): string {
	const label = attentionEventSpec(event)?.label ?? event;
	if (!recorded) return `${label}: nothing could be recorded for the owner, so they have not been told.`;
	switch (push) {
		case "sent":
			return `${label}: the owner was notified and it is in their notifications.`;
		case "muted":
			return `${label}: it is in the owner's notifications; they have turned this event's push off, so no push was sent.`;
		case "deduped":
			return `${label}: it is in the owner's notifications; a push for this same thing was already sent, so it did not buzz again.`;
		case "unavailable":
			return `${label}: it is in the owner's notifications, but no push could be delivered — they may have no device registered, or push is not configured here.`;
	}
}

export interface AttentionDeps {
	/** Injected so the policy is testable without the delivery stack. */
	notify: (env: Env, userId: string, type: string, title: string, body: string, url: DeepLink, opts: { key: string; kind: "alert" | "update"; instanceId?: string }) => Promise<void>;
	/**
	 * Did a push actually go out? Reported, never assumed.
	 *
	 * Both identities are handed over because they answer different questions: `key` is this
	 * request's own stable identity (what a caller logs), while `dedupeKey` is how the
	 * notifications table stores it — a HASH of (type, key, title, body). A lookup by `key` finds
	 * nothing, which would report every delivered push as `unavailable`: the exact lie this module
	 * exists to prevent.
	 */
	pushed?: (env: Env, userId: string, ids: { key: string; dedupeKey: string }) => Promise<PushOutcome>;
	preferences?: (env: Env, userId: string) => Promise<{ notifications?: NotificationPreferences; attention?: OwnerAttentionPreferences }>;
}

/**
 * Ask for the owner's attention. The one call any agent or workflow uses.
 *
 * Best-effort by construction, like every notification path in this codebase: a failure to notify
 * must never fail the work that noticed. What it does NOT do is lie about it — the outcome names
 * the channel that carried it, and `attentionDetail` is the sentence a caller may surface.
 */
export async function requestOwnerAttention(env: Env, req: OwnerAttentionRequest, deps: AttentionDeps): Promise<OwnerAttentionOutcome> {
	const spec = attentionEventSpec(req.event);
	const key = attentionKey(req.event, req.about);
	const url = deepLinkFor(req.subject);
	const kind = spec?.kind ?? "alert";

	const prefs = await deps.preferences?.(env, req.userId).catch(() => undefined);
	if (!attentionPushAllowed(prefs?.attention, req.event)) {
		// The owner's own choice: the row is still written, because the bell list is a log.
		const recorded = await deps
			.notify(env, req.userId, req.notificationType, req.title, req.body, url, { key, kind: "update", instanceId: req.instanceId })
			.then(() => true)
			.catch(() => false);
		return { event: req.event, recorded, push: "muted", key, url, detail: attentionDetail(req.event, "muted", recorded) };
	}

	const recorded = await deps
		.notify(env, req.userId, req.notificationType, req.title, req.body, url, { key, kind, instanceId: req.instanceId })
		.then(() => true)
		.catch(() => false);
	const push = recorded
		? ((await deps.pushed?.(env, req.userId, { key, dedupeKey: attentionNotificationKey(req) }).catch(() => "unavailable" as PushOutcome)) ?? "sent")
		: "unavailable";
	return { event: req.event, recorded, push, key, url, detail: attentionDetail(req.event, push, recorded) };
}

/** The dedupe key as the notification layer will hash it — exposed so a test can assert the pairing. */
export const attentionNotificationKey = (req: Pick<OwnerAttentionRequest, "event" | "about" | "notificationType" | "title" | "body">): string =>
	notificationDedupeKey(req.notificationType, attentionKey(req.event, req.about), req.title, req.body);
