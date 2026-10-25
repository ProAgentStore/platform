/**
 * What the release-notes panel says about each queued note, and which actions it offers (#1348).
 * Everything here is a pure function of the server's `ReleaseDelivery`: the server decides the `state`
 * and `actions`; this only words them and builds the request a button sends.
 */
import type { ReleaseDelivery, ReleaseDeliveryState } from "./types";

export const STATE_LABEL: Record<ReleaseDeliveryState, string> = {
	waiting_for_checks: "Waiting for checks",
	configuration_required: "Needs gate setup",
	configuration_changed: "Cancelled: settings changed",
	sending: "Sending",
	outcome_uncertain: "Outcome uncertain",
	delivery_failed: "Delivery failed",
	sent: "Delivered",
	expired: "Expired",
	abandoned: "Abandoned",
};

export type Tone = "ok" | "wait" | "warn" | "bad" | "muted";

export const STATE_TONE: Record<ReleaseDeliveryState, Tone> = {
	waiting_for_checks: "wait",
	configuration_required: "warn",
	configuration_changed: "muted",
	sending: "wait",
	outcome_uncertain: "warn",
	delivery_failed: "bad",
	sent: "ok",
	expired: "muted",
	abandoned: "muted",
};

/** What the owner can do next, in words. */
export const STATE_HINT: Record<ReleaseDeliveryState, string> = {
	waiting_for_checks: "It posts once every required workflow and the deploy step succeed for this commit.",
	configuration_required: "The release gate has no deploy job and step. Save the gate with them and this note resumes.",
	configuration_changed: "Cancelled because the setting or channel grant changed. It is not reopened by Retry.",
	sending: "A send is in flight.",
	outcome_uncertain: "The send may or may not have reached the channel, so nothing resends it for you. Check the channel, then settle it below.",
	delivery_failed: "The provider refused the post. Fix the cause (for example invite the bot), then retry.",
	sent: "",
	expired: "The 48-hour evidence window passed before every check succeeded.",
	abandoned: "You gave this note up; it is not sent.",
};

export const shortSha = (sha: string) => sha.slice(0, 7);

/** "Delivered to Slack #release-notes" / "Waiting for checks · Slack #release-notes". */
export function headline(d: ReleaseDelivery): string {
	const where = d.destination ? ` · ${d.destination.provider === "slack" ? "Slack" : "Discord"} ${d.destination.name}` : "";
	return `${STATE_LABEL[d.state]}${where}`;
}

/** Exactly the phrase the server requires before it will send an uncertain note again. */
export const RECONCILE_RETRY_PHRASE = "no post exists in the channel; send it again";

export const DUPLICATE_RISK = "Sending again can post the same announcement twice if the first one reached the channel. Look in the channel first; if the note is there, mark it delivered with its link instead.";

export type ReconcileChoice = "mark_delivered" | "abandon" | "retry_after_channel_check";

export interface ReconcileForm {
	choice: ReconcileChoice;
	permalink: string;
	channelChecked: boolean;
	typed: string;
}

/** Is the form complete enough to send? The server checks all of it again. */
export function reconcileReady(f: ReconcileForm): boolean {
	if (f.choice === "mark_delivered") return /^https:\/\/\S+$/.test(f.permalink.trim());
	if (f.choice === "abandon") return true;
	return f.channelChecked && f.typed === RECONCILE_RETRY_PHRASE;
}

/** The request body for the reconcile route; carries only the fields the chosen action takes. */
export function reconcileBody(f: ReconcileForm, idempotencyKey: string): Record<string, unknown> {
	if (f.choice === "mark_delivered") return { action: f.choice, permalink: f.permalink.trim(), idempotencyKey };
	if (f.choice === "abandon") return { action: f.choice, idempotencyKey };
	return { action: f.choice, channelChecked: true, confirm: f.typed, idempotencyKey };
}

/** Merge a newly read page after the rows already shown, dropping repeats by id (a stable cursor should not repeat; a double click must not duplicate). */
export function appendPage(shown: ReleaseDelivery[], page: ReleaseDelivery[]): ReleaseDelivery[] {
	const seen = new Set(shown.map((d) => d.id));
	return [...shown, ...page.filter((d) => !seen.has(d.id))];
}

/** Replace one row by id, keeping its place in the list. */
export const replaceDelivery = (rows: ReleaseDelivery[], next: ReleaseDelivery): ReleaseDelivery[] => rows.map((d) => (d.id === next.id ? next : d));

/** The blockers worth surfacing above the list: notes that will not send until the owner acts. */
export const needsAttention = (rows: ReleaseDelivery[]): ReleaseDelivery[] => rows.filter((d) => d.state === "delivery_failed" || d.state === "outcome_uncertain" || d.state === "configuration_required");
