/**
 * How a call waiting for approval is DESCRIBED on the board (#722 Step 2).
 *
 * PURE — no env, no D1 — so the one thing that decides whether an approval is informed or
 * theatre is unit-testable on its own.
 *
 * ── The card is the whole product here
 *
 * The gate's value is not that a human clicks; it is that a human clicks having SEEN the call. A
 * card reading "Approve gmail_send" is a consent dialog with the details removed — the owner
 * approves the agent, not the message, which is the state the gate exists to end. So the preview
 * names the arguments, in the tool's own declared order, and says when it cut one.
 *
 * ── Why this is connector-generic and not Gmail-shaped
 *
 * A Gmail-shaped card ("To / Subject / Body") would have to be rebuilt for the next irreversible
 * connector, which is the trap #720 documents for the consent panel's copy and the reason the
 * owner's 2026-08-22 decision ruled it out explicitly. The preview is therefore built from the
 * tool's `jsonSchema` property order, which for `gmail_send` IS to · cc · subject · body — the
 * right card, obtained without the tool being named anywhere in this file.
 *
 * Schema order, then leftovers: a tool whose handler accepts an argument its schema forgot still
 * shows it, because the argument is what will be sent and the schema is only how we know what to
 * call it.
 */
import { stableStringify } from "./stable-json.js";

/** The `type` every ask-gate ticket carries, so the board and the dedup query can find them. */
export const TOOL_APPROVAL_TASK_TYPE = "tool_approval";

/** Card budgets. `description` matches the 2000 that `/tasks/direct` and `create_ticket` cap at,
 *  so a preview can never be grown past the limit an ordinary ticket lives under. */
export const APPROVAL_TITLE_MAX = 200;
export const APPROVAL_DESCRIPTION_MAX = 2000;
/** Per-argument budget. Generous enough for an email body to be READ rather than glimpsed — the
 *  argument that most needs reading is usually the longest one. */
const ARG_VALUE_MAX = 600;

interface ApprovalSchema {
	properties?: Record<string, unknown>;
}

export interface ApprovalCard {
	title: string;
	/** The arguments, previewed. This is the part an owner actually reads before approving. */
	description: string;
	/** Why the card is here — the card's "Why:" block. */
	reasoning: string;
}

/** One argument rendered for a human: JSON for structure, plain text for a string. A string is
 *  quoted by `JSON.stringify` and an email body full of escaped newlines is unreadable, so a
 *  string goes in as itself. */
function renderValue(value: unknown): string {
	const raw = typeof value === "string" ? value : stableStringify(value);
	if (raw.length <= ARG_VALUE_MAX) return raw;
	// A cut SAYS SO, and says how much it cut — the same rule `card-detail.ts` holds for the board's
	// one-line detail, and it matters more here: a silently truncated body is a message the owner
	// approved without having seen its end.
	return `${raw.slice(0, ARG_VALUE_MAX)}… (+${raw.length - ARG_VALUE_MAX} more characters — open the ticket to see the whole call)`;
}

/** The argument names to show, in the order to show them: the tool's declared order first, then
 *  anything passed that the schema does not declare. */
export function previewArgOrder(schema: unknown, args: Record<string, unknown>): string[] {
	const declared = Object.keys(((schema as ApprovalSchema | null)?.properties ?? {}) as Record<string, unknown>);
	const present = declared.filter((k) => args[k] !== undefined);
	const extra = Object.keys(args).filter((k) => !declared.includes(k) && args[k] !== undefined);
	return [...present, ...extra];
}

/**
 * Compose the card for one queued call.
 *
 * `connectorLabel` is the owner's word for the connector (`Connector.label`), not its id, because
 * the card is read next to the consent control that carries the same word.
 */
export function buildApprovalCard(input: {
	toolName: string;
	connectorLabel: string;
	schema: unknown;
	args: Record<string, unknown>;
}): ApprovalCard {
	const { toolName, connectorLabel, schema, args } = input;
	const order = previewArgOrder(schema, args);
	const lines = order.map((key) => `${key}: ${renderValue(args[key])}`);
	const body = lines.length ? lines.join("\n") : "This call takes no arguments.";
	return {
		title: `Approve: ${toolName}`.slice(0, APPROVAL_TITLE_MAX),
		description: body.length > APPROVAL_DESCRIPTION_MAX ? `${body.slice(0, APPROVAL_DESCRIPTION_MAX - 1)}…` : body,
		// States the two things an owner needs and cannot infer from the arguments: that nothing has
		// happened yet, and that approving runs exactly this and nothing else.
		reasoning:
			`${toolName} acts through the ${connectorLabel} connector, whose write access on this agent is set to "Ask each time". ` +
			"Nothing has happened yet — this call has not run. Approving runs exactly the call shown above; the agent cannot change it, and declining it costs nothing but this one call.",
	};
}

/**
 * What the MODEL is told when its call was queued instead of run.
 *
 * `success: true` accompanies this (see the queue module) and the wording has to earn that:
 * nothing went wrong, the platform did exactly what the owner configured, so a model must not
 * read it as an error to route around — retry, try a different tool, apologise for a failure.
 *
 * It leads with "Nothing has been sent" because that is the clause the model will paraphrase to
 * the owner, and the one thing it must not get wrong is claiming the send happened. The last
 * sentence forbids the two failure modes observed in this class of message: retrying (which is
 * how one queued send becomes five cards) and reporting it as done.
 */
export function queuedCallMessage(input: {
	toolName: string;
	connectorLabel: string;
	ticketId: string;
	duplicate: boolean;
}): string {
	const dup = input.duplicate ? " — this exact call was already queued, so no second card was created" : "";
	return (
		`Nothing has been sent. ${input.toolName} is waiting for the owner's approval on the board${dup} (ticket ${input.ticketId}). ` +
		`Write access for ${input.connectorLabel} on this agent is set to "Ask each time", so it runs only once they approve that card. ` +
		"Tell them it is there and what it says. Do not retry the call, and do not report it as done."
	);
}

/**
 * The identity of a queued call — the same (tool, arguments) twice is the same request.
 *
 * Stops an agent filling the board with copies of one send. The chat tool loop already dedups
 * identical calls WITHIN a request (cross-round dedup, `agent-think.ts`); this is the other axis:
 * a model told "queued for approval" across three turns would otherwise queue it three times, and
 * an owner facing three identical cards cannot tell a duplicate from a second genuine send.
 *
 * Key-order-independent via `stableStringify`, for the reason that module states: two orderings of
 * the same arguments are the same call and must not hash differently.
 */
export function approvalFingerprint(toolName: string, args: Record<string, unknown>): string {
	return `${toolName}:${stableStringify(args)}`;
}
