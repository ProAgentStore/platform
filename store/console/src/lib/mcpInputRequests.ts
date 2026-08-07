// Interactive outbound-MCP calls (#264) — the console's pure half.
//
// A remote MCP server that needs something more from the person pauses the call and leaves a
// pending ask (`elicitation/create`, parsed server-side by lib/mcp-elicitation.ts). This module
// holds every decision the form makes — which control a field gets, what the draft starts as, what
// is still missing, and how long is left — so the component can be a render and the rules can be
// tested without a browser.
//
// The rule these decisions serve: the SERVER wrote the message and the field names, so everything
// here treats them as untrusted display data. Nothing is executed, nothing is interpreted as
// markup, and a `sensitive` field is masked and never echoed back into a title or a summary.

/** Mirrors McpInputField in workers/api/src/lib/mcp-elicitation.ts. */
export interface McpInputField {
	name: string;
	type: "string" | "number" | "integer" | "boolean";
	title?: string;
	description?: string;
	required: boolean;
	options?: string[];
	optionLabels?: string[];
	format?: string;
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	sensitive: boolean;
}

/** Mirrors McpInputStatus / McpInputRequestView in workers/api/src/lib/mcp-input-requests.ts. */
export type McpInputStatus = "pending" | "answered" | "cancelled" | "expired";

export interface McpInputRequest {
	id: string;
	endpoint: string;
	tool: string;
	status: McpInputStatus;
	round: number;
	maxRounds: number;
	message: string;
	fields: McpInputField[];
	traceId: string | null;
	expiresAt: string;
	createdAt: string;
}

/** What a form draft holds. Strings for everything typed, booleans for checkboxes — the shapes an
 *  HTML control actually produces; the server coerces and is the authority on what is valid. */
export type McpInputDraft = Record<string, string | boolean>;

/** The control a field gets. Derived from the field, never from the field's NAME alone except for
 *  `sensitive`, which the server already decided so the two surfaces cannot disagree about it. */
export type McpInputControl = "select" | "checkbox" | "number" | "password" | "text";

export function controlFor(field: McpInputField): McpInputControl {
	if (field.type === "boolean") return "checkbox";
	if (field.options?.length) return "select";
	if (field.type === "number" || field.type === "integer") return "number";
	// Masked, and — because the box is masked — never pre-filled and never echoed anywhere else.
	return field.sensitive ? "password" : "text";
}

/** The label a field is shown under. Falls back to the raw name, because a field with no title is
 *  still a field the user must fill in; hiding it would make the form impossible to complete. */
export function labelFor(field: McpInputField): string {
	return field.title?.trim() || field.name;
}

/** Display text for one enum choice — the server's own label when it supplied a matching list. */
export function optionLabel(field: McpInputField, index: number): string {
	return field.optionLabels?.[index] ?? field.options?.[index] ?? "";
}

/**
 * The starting draft. Everything empty, INCLUDING selects and checkboxes.
 *
 * Deliberately not pre-selecting the first enum option or defaulting a boolean to false: a
 * pre-filled answer is one the user did not give, and this form's answers are merged into a remote
 * tool call that may do something irreversible. An empty required field stops the submit; a
 * silently defaulted one is submitted as though it were considered.
 */
export function initialDraft(fields: readonly McpInputField[]): McpInputDraft {
	const draft: McpInputDraft = {};
	for (const f of fields) draft[f.name] = f.type === "boolean" ? false : "";
	return draft;
}

/** Required fields with nothing in them yet. A checkbox counts as answered either way — "no" is an
 *  answer to a yes/no question, and requiring it to be ticked would make it a consent box. */
export function missingRequired(fields: readonly McpInputField[], draft: McpInputDraft): string[] {
	return fields
		.filter((f) => f.required && f.type !== "boolean")
		.filter((f) => String(draft[f.name] ?? "").trim() === "")
		.map((f) => labelFor(f));
}

/** The body sent to the resume route. Blank optional fields are dropped rather than sent as "",
 *  because an empty string is a VALUE to a remote tool and "I left it blank" is not. */
export function answerPayload(fields: readonly McpInputField[], draft: McpInputDraft): Record<string, string | boolean> {
	const values: Record<string, string | boolean> = {};
	for (const f of fields) {
		const v = draft[f.name];
		if (typeof v === "boolean") {
			values[f.name] = v;
			continue;
		}
		const s = String(v ?? "");
		if (s.trim() === "") continue;
		values[f.name] = s;
	}
	return values;
}

/**
 * How long is left, in words. `null` once it has run out, so the caller renders the closed state
 * rather than a countdown that has gone negative — the timeout is the one part of this flow a user
 * discovers by being too slow, so it must read as a deadline before it becomes an explanation.
 */
export function timeLeft(expiresAt: string, now = Date.now()): string | null {
	const at = Date.parse(expiresAt);
	if (!Number.isFinite(at) || at <= now) return null;
	const mins = Math.ceil((at - now) / 60_000);
	if (mins <= 1) return "less than a minute left";
	return `${mins} minutes left`;
}

/** The one-line state for a request that is no longer answerable. Mirrors the server's
 *  `inputClosedNotice` in intent, phrased for the card the user is looking at. */
export function closedNote(status: McpInputStatus): string {
	switch (status) {
		case "expired":
			return "Timed out — nothing was sent. Ask the agent to try again.";
		case "cancelled":
			return "You cancelled this — nothing was sent.";
		case "answered":
			return "Answered.";
		case "pending":
			return "";
	}
}

/** Only pending asks get a form; the rest are history and are not shown by the panel at all. */
export function pendingOnly(requests: readonly McpInputRequest[]): McpInputRequest[] {
	return requests.filter((r) => r.status === "pending");
}
