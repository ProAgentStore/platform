// Interactive outbound-MCP calls (#264) — the PURE half.
//
// ── What a server actually asks, and what it does not
//
// Across every protocol revision this client speaks (`SUPPORTED_VERSIONS`), the ONE mechanism by
// which a remote MCP server asks the user for more input mid-call is **elicitation**: a
// server→client JSON-RPC request named `elicitation/create`, carrying a `message` and a
// `requestedSchema`. There is no "input_required" sentinel inside a `tools/call` result in any
// revision, so this module deliberately recognises `elicitation/create` and nothing else. Inventing
// a second wire shape to be generous about would be inventing a protocol, and every server that
// spoke it would be a server we wrote.
//
// ── Why the resume is a RETRY and not an in-band answer
//
// Answering an elicitation the way the spec draws it means POSTing a JSON-RPC response on a second
// request while the server holds the original stream open. `connectors/mcp.ts` `rpc()` does one
// `safeFetch` and `await res.text()`, so it cannot return until the server closes the stream, and
// the server will not close it until it gets the answer — they deadlock. In the MODERN era there
// is no server→client channel at all: one stateless POST, one answer. And the human takes minutes,
// which no Worker request may wait for.
//
// So what happens instead is exactly what the ticket asks for in its own words — "retry/resume the
// original call with the provided input responses". The answered values are merged into the remote
// tool's `arguments` and the call is made AGAIN, from the top, through `mcp_call_tool`. That has
// three properties worth stating out loud:
//
//   • The resume re-checks #262 per-(endpoint, tool) consent and re-resolves the #286 per-endpoint
//     credential, because it IS an ordinary call. Nothing is skipped as "already authorized" — a
//     grant revoked while the ask sat in the console must stop the resume, which is the whole
//     reason consent is checked at dispatch rather than at plan time.
//   • A server that does not accept the elicited values as arguments will simply ask again. That is
//     bounded by MAX_ROUNDS: each round costs a human answer, so it cannot spin on its own, but an
//     unbounded chain would still be a way to keep a person clicking forever.
//   • It is honest about being a retry. A tool with a side effect that already fired before the
//     server elicited will fire again — which is why `describeRounds` says so in the text the user
//     approves, rather than leaving them to discover it.
//
// ── The rule about values
//
// The ask (message + field names + types) is stored so the console can render it. The ANSWER never
// is: it arrives on the resume request, is merged, is dispatched, and the row is closed in the same
// handler. Nothing here logs a value, and `describeAnswer` exists precisely so the audit row can
// say "these three fields were supplied, 41 bytes" without becoming a second copy of the user's
// data — the same rule `connectors/mcp.ts` already applies to ordinary arguments.

/** A single value the server is asking for. Primitive by construction — MCP's elicitation schema
 *  is restricted to flat primitives, and a nested object is a schema we could not render. */
export interface McpInputField {
	name: string;
	type: "string" | "number" | "integer" | "boolean";
	title?: string;
	description?: string;
	required: boolean;
	/** String fields only. Present → the console renders a picker and the answer must be a member. */
	options?: string[];
	/** Display labels for `options`, when the server supplied `enumNames`. Same length or absent. */
	optionLabels?: string[];
	format?: string;
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	/**
	 * Whether this reads like a secret. Advisory ONLY — it decides that the console masks the box
	 * and that nothing echoes the value back, never whether the value may be sent. A server that
	 * names a field `note` and means "password" still gets an unmasked box; that is the server's
	 * mistake to make, and guessing harder would mask ordinary fields and teach people to ignore it.
	 */
	sensitive: boolean;
}

/** A parsed, renderable ask. `fields` may be empty — that is a pure confirmation ("proceed?"). */
export interface McpInputAsk {
	message: string;
	fields: McpInputField[];
}

/** Most fields one ask may carry. A server asking for fifty values in one round is not a form a
 *  human answers; it is either a bug or an attempt to make the console unusable. */
export const MAX_FIELDS = 20;

/** Longest string answer accepted for one field, before the field's own maxLength applies. */
export const MAX_VALUE_CHARS = 4096;

/**
 * How many times ONE logical call may be paused for input before it is refused.
 *
 * Each round costs a human answer, so this is not protecting against a runaway loop — it is
 * protecting against a server that never accepts the elicited values as arguments (the failure
 * mode this design's retry shape makes possible) and would otherwise keep a person answering the
 * same question forever with no signal that it is not working.
 */
export const MAX_ROUNDS = 3;

/** How long an unanswered ask stays answerable. Long enough for someone to come back from lunch,
 *  short enough that a stored encrypted copy of the call's arguments is not indefinite. */
export const INPUT_TTL_MS = 30 * 60_000;

/** The JSON-RPC method that IS an ask for user input. Nothing else is treated as one. */
export const ELICITATION_METHOD = "elicitation/create";

function isRecord(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown, cap: number): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim().slice(0, cap) : undefined;
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Names and formats that mean "do not put this on screen, in a log, or in a history entry". */
const SENSITIVE_WORDS = ["password", "passwd", "secret", "token", "apikey", "credential", "otp", "pin", "cvv", "ssn"];

/**
 * Does this field read like a secret? Matched on WORDS after splitting `snake_case` and
 * `camelCase`, the same way `isDestructiveToolName` does, so `api_key` and `apiKey` both hit and
 * `tokenized_count` does not become a masked box for no reason.
 */
export function isSensitiveField(name: string, format?: string): boolean {
	if (format === "password") return true;
	const words = String(name ?? "")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.map((w) => w.toLowerCase())
		.filter(Boolean);
	if (words.some((w) => SENSITIVE_WORDS.includes(w))) return true;
	// `api_key` / `apiKey` splits into two words, so ADJACENT PAIRS are joined and checked too —
	// otherwise the single most common secret field name in existence would be the one this misses.
	// Pairs and not the whole joined string: `pinned_count` collapses to something containing "pin",
	// and masking an ordinary field is how a mask stops meaning anything.
	return words.some((w, i) => i > 0 && SENSITIVE_WORDS.includes(words[i - 1] + w));
}

/**
 * Parse an `elicitation/create` request into something a console can render and a resume can
 * validate against. Returns `{ error }` for anything malformed.
 *
 * MALFORMED IS A REFUSAL, NOT A GUESS. A half-understood ask is worse than no ask: it produces a
 * form that collects the wrong values, sends them to a remote server, and reports the result as
 * the call the user meant. So every one of these is an error rather than a repair —
 *
 *   • a method that is not `elicitation/create`   (some other server→client request; not an ask)
 *   • no `message`                                (nothing to show a human; the form is unlabelled)
 *   • no object `requestedSchema.properties`      (we would be inventing the fields)
 *   • a REQUIRED property we cannot represent     (the call could never be satisfied)
 *   • more than MAX_FIELDS properties             (not a form a person answers)
 *
 * — and the caller falls back to the standing honest refusal, which already says nothing was
 * submitted. An OPTIONAL property of a type we cannot represent is dropped instead, because the
 * call can still complete without it and refusing would strand a working server on a field nobody
 * needed.
 */
export function parseElicitation(method: string, params: unknown): { ask: McpInputAsk } | { error: string } {
	if (method !== ELICITATION_METHOD) return { error: `"${String(method).slice(0, 60)}" is not a request for user input.` };
	if (!isRecord(params)) return { error: "the request carried no parameters." };
	const message = str(params.message, 2000);
	if (!message) return { error: "the request carried no message to show." };

	const schema = isRecord(params.requestedSchema) ? params.requestedSchema : null;
	const properties = schema && isRecord(schema.properties) ? schema.properties : null;
	if (!properties) return { error: "the request carried no requestedSchema describing what to collect." };

	const entries = Object.entries(properties);
	if (entries.length > MAX_FIELDS) return { error: `the request asks for ${entries.length} values, more than the ${MAX_FIELDS} one round may carry.` };

	const requiredNames = new Set(Array.isArray(schema?.required) ? schema.required.filter((n): n is string => typeof n === "string") : []);
	const fields: McpInputField[] = [];
	for (const [rawName, rawSpec] of entries) {
		const name = str(rawName, 128);
		const spec = isRecord(rawSpec) ? rawSpec : {};
		const required = !!name && requiredNames.has(rawName);
		const type = spec.type;
		if (!name || (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean")) {
			if (required) return { error: `it requires a value ("${String(rawName).slice(0, 60)}") of a kind this client cannot collect.` };
			continue;
		}
		const format = str(spec.format, 40);
		const options = Array.isArray(spec.enum) ? spec.enum.filter((v): v is string => typeof v === "string").slice(0, 50) : undefined;
		const optionLabels = Array.isArray(spec.enumNames) ? spec.enumNames.filter((v): v is string => typeof v === "string").slice(0, 50) : undefined;
		fields.push({
			name,
			type,
			title: str(spec.title, 200),
			description: str(spec.description, 500),
			required,
			options: options?.length ? options : undefined,
			// Only when it lines up: a mismatched label list would relabel the options, which is a
			// worse outcome than showing the raw values.
			optionLabels: options?.length && optionLabels?.length === options.length ? optionLabels : undefined,
			format,
			minLength: num(spec.minLength),
			maxLength: num(spec.maxLength),
			minimum: num(spec.minimum),
			maximum: num(spec.maximum),
			sensitive: isSensitiveField(name, format),
		});
	}
	return { ask: { message, fields } };
}

/** A value a user may supply. Everything MCP's elicitation schema can express. */
export type McpInputValue = string | number | boolean;

/**
 * Check the user's answer against the fields the server asked for, coercing the shapes an HTML
 * form actually produces (a number arrives as a string, a checkbox as `"true"`).
 *
 * Fields the server did NOT ask for are dropped rather than passed through. The answer is merged
 * into the remote tool's arguments, so accepting arbitrary extra keys would turn this route into a
 * way for anything that can reach it to rewrite the pending call's arguments — the one thing the
 * encrypted-at-rest payload exists to prevent.
 */
export function validateElicitationAnswer(
	fields: readonly McpInputField[],
	answer: unknown,
): { ok: true; values: Record<string, McpInputValue> } | { ok: false; error: string } {
	if (!isRecord(answer)) return { ok: false, error: "Supply the requested values as an object." };
	const values: Record<string, McpInputValue> = {};
	for (const field of fields) {
		const raw = answer[field.name];
		const label = field.title ?? field.name;
		if (raw === undefined || raw === null || raw === "") {
			if (field.required) return { ok: false, error: `"${label}" is required.` };
			continue;
		}
		if (field.type === "boolean") {
			const v = typeof raw === "boolean" ? raw : raw === "true" ? true : raw === "false" ? false : null;
			if (v === null) return { ok: false, error: `"${label}" must be true or false.` };
			values[field.name] = v;
			continue;
		}
		if (field.type === "number" || field.type === "integer") {
			const v = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
			if (!Number.isFinite(v)) return { ok: false, error: `"${label}" must be a number.` };
			if (field.type === "integer" && !Number.isInteger(v)) return { ok: false, error: `"${label}" must be a whole number.` };
			if (field.minimum !== undefined && v < field.minimum) return { ok: false, error: `"${label}" must be at least ${field.minimum}.` };
			if (field.maximum !== undefined && v > field.maximum) return { ok: false, error: `"${label}" must be at most ${field.maximum}.` };
			values[field.name] = v;
			continue;
		}
		if (typeof raw !== "string") return { ok: false, error: `"${label}" must be text.` };
		if (raw.length > MAX_VALUE_CHARS) return { ok: false, error: `"${label}" is too long.` };
		if (field.options && !field.options.includes(raw)) return { ok: false, error: `"${label}" must be one of the offered choices.` };
		if (field.minLength !== undefined && raw.length < field.minLength) return { ok: false, error: `"${label}" must be at least ${field.minLength} characters.` };
		if (field.maxLength !== undefined && raw.length > field.maxLength) return { ok: false, error: `"${label}" must be at most ${field.maxLength} characters.` };
		values[field.name] = raw;
	}
	return { ok: true, values };
}

/**
 * Fold the answered values into the original call's arguments.
 *
 * The ANSWER WINS on a name collision, and that is the point rather than an accident: the server
 * elicited because what it already had was missing or unusable, so re-sending the original value
 * would reproduce the ask verbatim and the round would achieve nothing.
 */
export function mergeElicitedArgs(args: Record<string, unknown>, values: Record<string, McpInputValue>): Record<string, unknown> {
	return { ...args, ...values };
}

/**
 * What may be written to the trace about an answer: the field NAMES and the total size, never a
 * value. Same rule `connectors/mcp.ts` applies to ordinary arguments — an audit row that kept the
 * values would turn the log into a second copy of the most PII-dense thing this connector touches,
 * and an elicited value is more likely to be a password than an ordinary argument is.
 */
export function describeAnswer(values: Record<string, McpInputValue>): { keys: string[]; bytes: number } {
	const keys = Object.keys(values).slice(0, MAX_FIELDS);
	return { keys, bytes: JSON.stringify(values).length };
}

/** The lifecycle of one pending ask. Stored as a column so a resume is a compare-and-swap. */
export type McpInputStatus = "pending" | "answered" | "cancelled" | "expired";

/**
 * The state an ask is REALLY in, which is not always the state the column says.
 *
 * A pending row past its expiry is expired whether or not anything has swept it — the timeout must
 * be a property of the clock, not of a cron having run. Deriving it here means the console badge,
 * the resume gate and the sweeper cannot disagree about whether an answer is still accepted.
 */
export function resolveInputStatus(row: { status: string; expiresAt: string | null }, now = Date.now()): McpInputStatus {
	if (row.status === "answered" || row.status === "cancelled" || row.status === "expired") return row.status;
	const at = row.expiresAt ? Date.parse(row.expiresAt) : Number.NaN;
	if (Number.isFinite(at) && at <= now) return "expired";
	return "pending";
}

/** Why an answer was refused, said in a way that names the remedy. */
export function inputClosedNotice(status: McpInputStatus): string {
	switch (status) {
		case "expired":
			return "That request timed out, so nothing was sent and the call did not complete. Ask the agent to try again — it will re-ask for whatever the server still needs.";
		case "cancelled":
			return "You cancelled that request, so nothing was sent.";
		case "answered":
			return "That request was already answered.";
		case "pending":
			return "That request is still waiting for an answer.";
	}
}

/**
 * The sentence the AGENT gets when a call pauses. Written for a model, and every clause is load-
 * bearing: the failure this ticket exists to stop is an agent narrating a submission that never
 * happened, so it must be told the call is incomplete, that a human is now in the loop, and that
 * waiting is the correct behaviour rather than retrying with invented values.
 */
export function pausedForInputNotice(tool: string, endpoint: string, message: string, fieldCount: number): string {
	const what = fieldCount === 0 ? "a confirmation" : `${fieldCount} value${fieldCount === 1 ? "" : "s"}`;
	return (
		`PAUSED — "${tool}" on ${endpoint} needs ${what} from the person before it can finish, so the call did NOT complete ` +
		`and nothing was submitted. The request has been put in the console for them to answer; when they do, this exact call ` +
		`is retried with their answer. The server asked: "${message.slice(0, 300)}". Do not invent the values, do not call the ` +
		`tool again, and do not report this as done — say you are waiting on them.`
	);
}

// NOTE: the sentence describing what a RESUME does ("answering re-sends the whole call…") lives in
// the console, not here, because it is the only one of these strings the SERVER never says. It
// still has to be said somewhere before the button is pressed: a remote tool that half-completed
// before it elicited will run its first half again, and that is the one thing about this design a
// user could be surprised by. See components/McpInputRequests.tsx.
