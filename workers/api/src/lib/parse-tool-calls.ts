/**
 * Parse tool calls from response text when the model embeds them as JSON
 * instead of using the structured tool_calls field.
 * Handles: single calls, multiple calls separated by ;, nested JSON in data fields.
 *
 * `allowed` — the caller's resolved tool allowlist. Pass it. Text-embedded JSON is ambiguous by
 * construction, and without a name check ANY object carrying a `name` key was accepted as a tool
 * call:
 *
 *   A repo-chat agent asked "what's in package.json" answers with
 *   `{"name":"@proagentstore/sdk","version":"0.4.0",…}` inline. `tool_calls` is empty, so the
 *   text is parsed, and that object becomes a call to a tool named `@proagentstore/sdk`. Because
 *   `toolCalls.length > 0`, the "no tools → return the reply" early return is SKIPPED and **the
 *   model's correct answer is thrown away**. The name then fails the allowlist, nothing executes,
 *   the round breaks, and the user gets an answer regenerated from a transcript reading
 *   "I called tools: [@proagentstore/sdk]: This tool isn't available to this agent".
 *
 * Any agent echoing a record with a `name` field — a lead, a site, a package — hit this. Filtering
 * here means such an object stays prose and the reply survives. A genuine attempt to call a
 * DISALLOWED tool still gets its refusal through the structured `tool_calls` path, which is
 * unambiguous.
 *
 * RETURNS THE TEXT IT ATE (#395). This used to return only the calls, and nothing downstream
 * cleaned up after it, so a text-embedded call survived into the persisted message and onto the
 * user's screen — the reported half of #395. Returning `{ calls, text }` makes the strip
 * impossible to forget: the caller cannot get the calls without also being handed the reply with
 * their spans removed. The wider markup families the model wraps around these objects
 * (`<tool_call>`, `</parameter>`, and any invented `<tool_response>`) are not this walker's
 * business — they are stripped and adjudicated in `invented-results.ts`.
 *
 * ONE wrapper is: Llama 3.x's documented custom-tool form, `<function=NAME>{…}</function>` (#853
 * finding 3). Its object carries no `name` — the tag does — so the walker skipped it and the whole
 * thing reached the owner's screen as a call that never happened. It is read here, by the tag's name
 * and under the same allowlist, with the closing tag optional (Llama often drops it); the span goes,
 * tags included, and the name is reported like any other call written as text — never executed.
 */
export function parseToolCallsFromText(
	text: string,
	allowed?: ReadonlySet<string>,
): { calls: Array<{ name: string; arguments: Record<string, unknown> }>; text: string } {
	const found: Array<{ span: [number, number]; call: { name: string; arguments: Record<string, unknown> } }> = [];
	// Llama's `<function=NAME>{…}</function>` first (#853 finding 3): its object has no `name` of its own.
	for (const m of text.matchAll(/<function=([\w.-]+)>\s*/g)) {
		const name = m[1];
		const open = (m.index ?? 0) + m[0].length;
		if (text[open] !== "{" || (allowed && !allowed.has(name))) continue;
		const close = findMatchingBrace(text, open);
		if (close === -1) continue;
		try {
			const args = JSON.parse(text.slice(open, close + 1));
			if (!args || typeof args !== "object" || Array.isArray(args)) continue;
			const tail = /^\s*<\/function>/.exec(text.slice(close + 1));
			found.push({ span: [m.index ?? 0, close + 1 + (tail ? tail[0].length : 0)], call: { name, arguments: args } });
		} catch {
			// Not an object: the tag stays prose, like any brace that is not JSON below.
		}
	}
	const inTag = (at: number) => found.some(({ span: [s, e] }) => at >= s && at < e);
	// Walk the text character by character, extracting balanced JSON objects
	let i = 0;
	while (i < text.length) {
		const start = text.indexOf("{", i);
		if (start === -1) break;
		if (inTag(start)) {
			i = start + 1;
			continue;
		}
		// Find the matching closing brace (handle nesting + strings)
		const end = findMatchingBrace(text, start);
		if (end === -1) { i = start + 1; continue; }
		const jsonStr = text.slice(start, end + 1);
		i = end + 1;
		try {
			const parsed = JSON.parse(jsonStr);
			const name = parsed.name || parsed.function?.name;
			// A tool name is a STRING and, when the caller told us what exists, a REAL tool.
			// `normalizeToolCalls` already guards the type on the structured path; this one did not.
			if (typeof name !== "string" || !name) continue;
			if (allowed && !allowed.has(name)) continue;
			let rawArgs = parsed.parameters ?? parsed.arguments ?? parsed.function?.arguments;
			if (rawArgs === undefined || rawArgs === null) {
				// Flat shape: no args wrapper, so the arguments are the sibling top-level keys
				// (e.g. {"name":"write_memory","key":"x","type":"knowledge","content":"y"}).
				// Strip only the wrapper keys — keep every other field (incl. a genuine `type` arg).
				const { name: _n, function: _f, parameters: _p, arguments: _a, ...rest } = parsed;
				rawArgs = rest;
			}
			const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
			found.push({ span: [start, end + 1], call: { name, arguments: args } });
		} catch {
			// Ignorable BY CONSTRUCTION, and the only correct behaviour here (#291). This is a
			// SCANNER: it walks every `{` in the model's prose and asks "was that JSON?". A throw
			// is the answer "no" for the overwhelming majority of braces in an ordinary reply, so
			// reporting it would file a row per sentence. The span is simply not added to `spans`,
			// which leaves the text where it was — the honest outcome, since a fragment that did
			// not parse is not a tool call and must stay visible to the reader.
		}
	}
	// Both forms, in the order they were written.
	found.sort((a, b) => a.span[0] - b.span[0]);
	return { calls: found.map((f) => f.call), text: removeSpans(text, withWrappers(text, found.map((f) => f.span))) };
}

/**
 * The call spans, widened over what existed only to HOLD the calls (#853 finding 6): the `,`/`;`
 * between adjacent calls, a `[ … ]` wrapping nothing but calls, and Llama's `<|python_tag|>` right
 * before them. Cutting the calls alone left `[,]`, `;` or a bare tag as the owner's reply. Nothing
 * beyond that is taken — a sentence's own `;` or a bracket that also holds prose stays.
 */
function withWrappers(text: string, spans: ReadonlyArray<[number, number]>): Array<[number, number]> {
	const groups: Array<[number, number]> = [];
	for (const [start, end] of spans) {
		const last = groups.at(-1);
		if (last && /^[\s,;]*$/.test(text.slice(last[1], start))) last[1] = end;
		else groups.push([start, end]);
	}
	return groups.map(([start, end]) => {
		const open = /\[\s*$/.exec(text.slice(0, start));
		const close = /^\s*\]/.exec(text.slice(end));
		if (open && close) [start, end] = [open.index, end + close[0].length];
		const tag = /<\|python_tag\|>\s*$/.exec(text.slice(0, start));
		return [tag ? tag.index : start, end];
	});
}

/** Cut the given [start, end) ranges out of `text`. Ranges arrive in order and never overlap. */
function removeSpans(text: string, spans: ReadonlyArray<[number, number]>): string {
	if (spans.length === 0) return text;
	let out = "";
	let cursor = 0;
	for (const [start, end] of spans) {
		out += text.slice(cursor, start);
		cursor = end;
	}
	return `${out}${text.slice(cursor)}`;
}

/** Find the index of the closing brace that matches the opening brace at `start`. */
function findMatchingBrace(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escaped) { escaped = false; continue; }
		if (ch === "\\") { escaped = true; continue; }
		if (ch === '"') { inString = !inString; continue; }
		if (inString) continue;
		if (ch === "{") depth++;
		if (ch === "}") { depth--; if (depth === 0) return i; }
	}
	return -1;
}

/**
 * Normalize tool_calls from Workers AI response.
 * REST API returns OpenAI format: tool_calls[i].function.{name, arguments}
 * Workers AI binding returns flat: tool_calls[i].{name, arguments}
 *
 * `id` is passed through when the provider supplied one (#398). It is the provider's `tool_use` id
 * and the only thing that ties a result back to the call that asked for it — without it, two calls
 * to the same tool with different arguments in one round produce two results the model can only
 * tell apart by reading them. Optional, because the text-embedded path has no ids to give and the
 * Workers-AI fallback does not use them; a caller that needs the structured protocol checks for it.
 */
export function normalizeToolCalls(rawCalls: unknown[]): ToolCall[] {
	return splitToolCalls(rawCalls).calls;
}

export type ToolCall = { name: string; arguments: Record<string, unknown>; id?: string };

/** A call the model made whose `arguments` could not be read — never run, always answered (#853 finding 4). */
export type MalformedToolCall = { name: string; id?: string; error: string };

/** What the model is told about such a call, in that call's own result slot. */
export const malformedCallAnswer = (m: MalformedToolCall) =>
	`Not run — its arguments were not valid JSON (${m.error}). Call it again with its arguments as one complete JSON object.`;

/**
 * {@link normalizeToolCalls}, plus the calls it could NOT normalize. A call with malformed `arguments`
 * is kept out of `calls` — one bad call must not fail the batch, and it must never run on arguments
 * guessed from a fragment — but it is no longer dropped without a word: it comes back in `malformed`
 * so the caller can tell the model, or the owner, what happened to it (#853 finding 4). Empty or
 * whitespace-only `arguments` are not malformed: that is a call with no arguments.
 */
export function splitToolCalls(rawCalls: unknown[]): { calls: ToolCall[]; malformed: MalformedToolCall[] } {
	const calls: ToolCall[] = [];
	const malformed: MalformedToolCall[] = [];
	for (const tc of rawCalls) {
		const call = (tc ?? {}) as Record<string, unknown>;
		const fn = call.function && typeof call.function === "object" ? (call.function as Record<string, unknown>) : null;
		const name = fn ? fn.name : call.name;
		const rawArgs = fn ? fn.arguments : call.arguments;
		if (typeof name !== "string" || !name) continue;
		const id = typeof call.id === "string" && call.id ? call.id : undefined;
		let parsed: unknown;
		try {
			parsed = typeof rawArgs === "string" ? (rawArgs.trim() ? JSON.parse(rawArgs) : {}) : rawArgs;
		} catch (e) {
			malformed.push({ name, ...(id ? { id } : {}), error: (e instanceof Error ? e.message : String(e)).slice(0, 160) });
			continue;
		}
		// Non-object results collapse to {}.
		const args = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
		calls.push({ name, arguments: args, ...(id ? { id } : {}) });
	}
	return { calls, malformed };
}
