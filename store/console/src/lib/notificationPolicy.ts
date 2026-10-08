import type { InstanceNotificationPolicy, NotificationPolicyRule, NotificationVocabulary } from "./types";

/**
 * The console's half of the notification policy (#992) — PURE, so the three-state logic that
 * decides what a save sends is unit-tested without a browser.
 *
 * What it deliberately does NOT do is resolve precedence. The effective state and its source come
 * from the server (`workers/api/src/lib/notification-policy.ts`), because a second implementation
 * of the precedence order would be a second answer and the one shown here would be the wrong one.
 * This module only maps between the editor's rows and the rule list the API stores.
 */

/** Three states, because "inherit" is a real choice and not the absence of one. */
export type PolicyChoice = "inherit" | "on" | "off";

export type PolicySource = "instance" | "account" | "baseline" | "default";

export const SOURCE_LABEL: Record<PolicySource, string> = {
	instance: "set here",
	account: "from your account",
	baseline: "from your account",
	default: "platform default",
};

export const CHANNEL_HELP = {
	inapp: "The console's notification list — the record of what happened.",
	push: "An interruption on every device you have enabled alerts on.",
} as const;

export interface PolicyCell {
	choice: PolicyChoice;
	allowed: boolean;
	source: PolicySource;
}

/** One editable line: a notification type × severity, or a generic event. */
export interface PolicyRow {
	key: string;
	label: string;
	description: string;
	/** The selector this row writes when it is not inheriting. */
	selector: NotificationPolicyRule;
	inapp: PolicyCell;
	push: PolicyCell;
}

const severityLabel = (s: "update" | "alert") => (s === "alert" ? "waiting on you" : "progress");

/**
 * Build the editor's rows from the served vocabulary and the instance's resolved state.
 *
 * A row's CHOICE is "inherit" unless this instance's own rules decide that channel — which is
 * exactly what `source === "instance"` means, so the control and the explanation beside it cannot
 * disagree.
 */
export function policyRows(vocab: NotificationVocabulary, policy: InstanceNotificationPolicy): PolicyRow[] {
	const rows: PolicyRow[] = [];
	const cell = (allowed: boolean, source: PolicySource): PolicyCell => ({
		choice: source === "instance" ? (allowed ? "on" : "off") : "inherit",
		allowed,
		source,
	});
	// Each list is read defensively because this is a BOUNDARY: a 200 whose body is not the
	// declared shape would otherwise throw during render, and an exception here takes the whole
	// Settings tab down with it — not just this card. That is not hypothetical; it is what the
	// research e2e mock (which answers every unmatched route `{}`) demonstrated, and the same
	// trap its own comment records for the trigger form. No rows is an honest empty editor.
	const types = vocab?.types ?? [];
	const events = vocab?.events ?? [];
	const severities = vocab?.severities ?? [];
	const effective = (match: (e: InstanceNotificationPolicy["effective"][number]) => boolean) => (policy?.effective ?? []).find(match);

	for (const event of events) {
		const row = effective((e) => e.event === event.id);
		if (!row) continue;
		rows.push({
			key: `event:${event.id}`,
			label: event.label,
			description: event.description,
			selector: { event: event.id },
			inapp: cell(row.inapp.allowed, row.inapp.source),
			push: cell(row.push.allowed, row.push.source),
		});
	}
	for (const type of types) {
		for (const severity of severities) {
			const row = effective((e) => e.type === type.id && e.severity === severity && !e.event);
			if (!row) continue;
			// A type that never raises an alert has no alert row worth showing: the control would
			// configure something that cannot happen.
			if (severity === "alert" && !type.alerts) continue;
			rows.push({
				key: `type:${type.id}:${severity}`,
				label: `${type.label} — ${severityLabel(severity)}`,
				description: severity === "alert" ? "A run that has stopped and is waiting for you." : type.description,
				selector: { type: type.id, severity },
				inapp: cell(row.inapp.allowed, row.inapp.source),
				push: cell(row.push.allowed, row.push.source),
			});
		}
	}
	return rows;
}

/**
 * The rule list a save sends: one rule per row that decides something, carrying only the channels
 * that row actually chose.
 *
 * A row left on "inherit" for both channels contributes NOTHING — which is what makes "restore
 * inherited" expressible as an empty list rather than as a rule that says "decide nothing", a rule
 * the API would refuse (and should: a stored rule that changes no outcome is a control the owner
 * believes they set).
 */
export function rulesFromChoices(rows: PolicyRow[]): NotificationPolicyRule[] {
	const rules: NotificationPolicyRule[] = [];
	for (const row of rows) {
		const rule: NotificationPolicyRule = { ...row.selector };
		if (row.inapp.choice !== "inherit") rule.inapp = row.inapp.choice === "on";
		if (row.push.choice !== "inherit") rule.push = row.push.choice === "on";
		if (rule.inapp === undefined && rule.push === undefined) continue;
		rules.push(rule);
	}
	return rules;
}
