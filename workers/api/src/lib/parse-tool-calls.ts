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
 */
export function parseToolCallsFromText(text: string, allowed?: ReadonlySet<string>): Array<{ name: string; arguments: Record<string, unknown> }> {
	const results: Array<{ name: string; arguments: Record<string, unknown> }> = [];
	// Walk the text character by character, extracting balanced JSON objects
	let i = 0;
	while (i < text.length) {
		const start = text.indexOf("{", i);
		if (start === -1) break;
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
			results.push({ name, arguments: args });
		} catch {
		}
	}
	return results;
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
 */
export function normalizeToolCalls(
	rawCalls: unknown[],
): Array<{ name: string; arguments: Record<string, unknown> }> {
	const out: Array<{ name: string; arguments: Record<string, unknown> }> = [];
	for (const tc of rawCalls) {
		try {
			const call = tc as Record<string, unknown>;
			let name: unknown;
			let rawArgs: unknown;
			if (call.function && typeof call.function === "object") {
				const fn = call.function as Record<string, unknown>;
				name = fn.name;
				rawArgs = fn.arguments;
			} else {
				name = call.name;
				rawArgs = call.arguments;
			}
			if (typeof name !== "string" || !name) continue;
			// A model can emit malformed JSON in `arguments`. Parse defensively: skip just
			// THIS call rather than letting a bare JSON.parse throw and drop the whole batch
			// (which failed the entire chat turn). Non-object results collapse to {}.
			const parsed = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
			const args = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
			out.push({ name, arguments: args });
		} catch {
			// malformed arguments for this call — skip it, keep the rest
		}
	}
	return out;
}
