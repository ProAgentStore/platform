/**
 * Gmail filters an agent may PROPOSE — and an owner must approve, one at a time (#719).
 *
 * Owner decision 2026-10-14: filter creation is allowed only with explicit per-action owner
 * approval. There is no standing authority: `gmail_create_filter` is the one Gmail tool that is
 * queued for approval on EVERY call, whatever the connector's write consent says ("Always allow"
 * included). See ADR 0007.
 *
 * Why a filter is different from every other Gmail power (the issue's argument, kept here because
 * it is what this module enforces). Reply, send and archive are per-message and backward-looking.
 * A filter is standing, silent and forward-looking: it acts on mail that has not arrived yet, and
 * it fires with nobody watching. Gmail is also the connector whose input strangers write. The
 * injection that matters is SUPPRESSION: "make mail from security@ skip the inbox" hides exactly the
 * mail that would warn the owner. So the card must say, before approval, that the rule applies to
 * all future matching mail, until it is deleted in Gmail.
 *
 * What this module refuses at the tool boundary, never in a prompt:
 *   - forwarding, of any kind. `gmail.settings.basic` can create a filter that forwards to an
 *     address already verified on the account, and that is a standing exfiltration channel. There
 *     is no `forward` parameter, and a request carrying one is refused rather than ignored;
 *   - trash, delete and spam, including as a label (`TRASH` / `SPAM` via add-label is the same act);
 *   - a filter with no criteria, which would match ALL mail.
 *
 * PURE: no env, no I/O. The connector resolves the mailbox and labels; this decides what is
 * allowed and how it is shown.
 */

import { clipMarked } from "./clip-marked.js";
import { APPROVAL_TITLE_MAX } from "./tool-approval.js";

/** The only things an approved filter may do. Each is reversible from Gmail by the owner. */
export const FILTER_ACTIONS = ["skip_inbox", "mark_read", "star", "add_label"] as const;
export type FilterAction = (typeof FILTER_ACTIONS)[number];

/** Asked for and REFUSED by name, so a model learns it is a boundary, not a missing feature. */
const REFUSED_ACTIONS: Record<string, string> = {
	forward: "Filters that forward mail are never created by an agent: a forwarding rule is a standing channel out of the mailbox. Set one up yourself in Gmail if you want it.",
	trash: "Filters that trash mail are not allowed: they would hide future mail silently.",
	delete: "Filters that delete mail are not allowed: they would hide future mail silently.",
	spam: "Filters that send mail to spam are not allowed: they would hide future mail silently.",
	never_spam: "Filters that change spam handling are not allowed.",
	mark_important: "Filters that change importance are not allowed.",
};

/** Labels whose addition IS one of the refused acts, or a system state an agent must not set. */
const REFUSED_LABEL_NAMES = new Set(["TRASH", "SPAM", "INBOX", "UNREAD", "SENT", "DRAFT", "IMPORTANT", "STARRED", "CHAT"]);

export interface FilterCriteria {
	from?: string;
	to?: string;
	subject?: string;
	query?: string;
	negated_query?: string;
	has_attachment?: boolean;
}

export interface FilterRequest {
	criteria: FilterCriteria;
	actions: FilterAction[];
	/** For `add_label`: the existing user label's exact name. */
	label?: string;
	/** Why the agent proposes it — shown on the card, in its own words. */
	reason: string;
}

const CRITERIA_KEYS = ["from", "to", "subject", "query", "negated_query"] as const;
const MAX_FIELD = 300;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Validate a proposed filter. Returns the request, or the refusal the model is told. */
export function parseFilterRequest(input: Record<string, unknown>): { ok: true; request: FilterRequest } | { ok: false; error: string } {
	for (const key of ["forward", "forward_to", "forwardTo"]) {
		if (input[key] !== undefined) return { ok: false, error: REFUSED_ACTIONS.forward };
	}
	const rawActions = Array.isArray(input.actions) ? input.actions : typeof input.actions === "string" ? [input.actions] : [];
	const actions: FilterAction[] = [];
	for (const a of rawActions) {
		const name = str(a).toLowerCase();
		if (REFUSED_ACTIONS[name]) return { ok: false, error: REFUSED_ACTIONS[name] };
		if (!(FILTER_ACTIONS as readonly string[]).includes(name)) {
			return { ok: false, error: `Unknown filter action "${name}". Allowed: ${FILTER_ACTIONS.join(", ")}.` };
		}
		if (!actions.includes(name as FilterAction)) actions.push(name as FilterAction);
	}
	if (actions.length === 0) return { ok: false, error: `Say what the filter does: actions must include at least one of ${FILTER_ACTIONS.join(", ")}.` };

	const criteria: FilterCriteria = {};
	for (const key of CRITERIA_KEYS) {
		const v = str(input[key]);
		if (!v) continue;
		if (v.length > MAX_FIELD) return { ok: false, error: `${key} is longer than ${MAX_FIELD} characters — narrow it rather than send a truncated rule.` };
		criteria[key] = v;
	}
	if (input.has_attachment === true) criteria.has_attachment = true;
	// `negated_query` alone still matches almost everything, so it does not count as a criterion.
	if (!criteria.from && !criteria.to && !criteria.subject && !criteria.query && !criteria.has_attachment) {
		return { ok: false, error: "A filter needs at least one of from, to, subject, query or has_attachment — without one it would match ALL mail." };
	}

	const label = str(input.label);
	if (actions.includes("add_label")) {
		if (!label) return { ok: false, error: "add_label needs `label`: the exact name of an existing label in this mailbox." };
		if (REFUSED_LABEL_NAMES.has(label.toUpperCase())) return { ok: false, error: `"${label}" is a Gmail system label; a filter may only add one of your own labels.` };
	} else if (label) {
		return { ok: false, error: "`label` is only used with the add_label action." };
	}

	const reason = str(input.reason);
	if (!reason) return { ok: false, error: "Give a `reason`: the owner sees it on the approval card next to the rule." };
	if (reason.length > 500) return { ok: false, error: "reason is longer than 500 characters — say it in a sentence or two." };

	return { ok: true, request: { criteria, actions, ...(label ? { label } : {}), reason } };
}

/** The filter in Gmail's own vocabulary, for `users.settings.filters.create`. */
export function gmailFilterBody(request: FilterRequest, labelId: string | null): { criteria: Record<string, unknown>; action: { addLabelIds: string[]; removeLabelIds: string[] } } {
	const c = request.criteria;
	const criteria: Record<string, unknown> = {
		...(c.from ? { from: c.from } : {}),
		...(c.to ? { to: c.to } : {}),
		...(c.subject ? { subject: c.subject } : {}),
		...(c.query ? { query: c.query } : {}),
		...(c.negated_query ? { negatedQuery: c.negated_query } : {}),
		...(c.has_attachment ? { hasAttachment: true } : {}),
	};
	const addLabelIds: string[] = [];
	const removeLabelIds: string[] = [];
	if (request.actions.includes("skip_inbox")) removeLabelIds.push("INBOX");
	if (request.actions.includes("mark_read")) removeLabelIds.push("UNREAD");
	if (request.actions.includes("star")) addLabelIds.push("STARRED");
	if (request.actions.includes("add_label") && labelId) addLabelIds.push(labelId);
	// No `forward` key, ever: the body is built from this allowlist, not from the input.
	return { criteria, action: { addLabelIds, removeLabelIds } };
}

const ACTION_WORDS: Record<FilterAction, string> = {
	skip_inbox: "skip the inbox (archive)",
	mark_read: "mark as read",
	star: "star",
	add_label: "add label",
};

/** The rule in words: "from: x AND subject: y". */
export function describeCriteria(c: FilterCriteria): string {
	const parts = [
		c.from && `from: ${c.from}`,
		c.to && `to: ${c.to}`,
		c.subject && `subject: ${c.subject}`,
		c.query && `matches search: ${c.query}`,
		c.negated_query && `does NOT match: ${c.negated_query}`,
		c.has_attachment && "has an attachment",
	].filter(Boolean);
	return parts.join(" AND ");
}

export function describeActions(r: FilterRequest): string {
	return r.actions.map((a) => (a === "add_label" ? `${ACTION_WORDS[a]} "${r.label}"` : ACTION_WORDS[a])).join(", ");
}

/**
 * The approval card. Everything the owner needs BEFORE deciding, in order: which mailbox, the exact
 * rule, what it does, why the agent wants it, and what approving it means for mail that has not
 * arrived yet. Opening the card does nothing; only Approve runs it, once.
 */
export function filterApprovalCard(r: FilterRequest, mailbox: string): { title: string; description: string; reasoning: string } {
	const hides = r.actions.includes("skip_inbox") || r.actions.includes("mark_read");
	return {
		// The full address is always in the description; a very long one is clipped, marked, in the title only.
		title: clipMarked(`Approve Gmail filter on ${mailbox}`, APPROVAL_TITLE_MAX, { within: true }),
		description: [
			`Mailbox: ${mailbox}`,
			`When a message arrives that matches: ${describeCriteria(r.criteria)}`,
			`Gmail will: ${describeActions(r)}`,
			`Agent's reason: ${r.reason}`,
		].join("\n"),
		reasoning: [
			"Scope: this is a standing rule, not a one-off. It applies to ALL FUTURE mail that matches, from the moment you approve, until you delete it in Gmail → Settings → Filters. It does not change mail you already have.",
			hides ? "Risk: matching mail will be hidden from your inbox or marked read without anyone looking at it. Check that the rule cannot catch mail you need to see (security alerts, billing, people you deal with)." : "Risk: it changes how matching mail is labelled without anyone looking at it.",
			"Forwarding: this rule never forwards mail — the platform refuses forwarding, trash, delete and spam filters outright. The Gmail permission behind it (filter management) is also able to manage forwarding settings, but no tool here uses that.",
			"Nothing has happened yet. Approving creates exactly this rule once; the agent cannot change it, and declining costs nothing.",
		].join("\n"),
	};
}
