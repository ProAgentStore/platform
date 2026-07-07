/**
 * Parse tool calls from response text when the model embeds them as JSON
 * instead of using the structured tool_calls field.
 * Handles: single calls, multiple calls separated by ;, nested JSON in data fields.
 */
export function parseToolCallsFromText(text: string): Array<{ name: string; arguments: Record<string, unknown> }> {
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
			if (!name) continue;
			const rawArgs = parsed.parameters || parsed.arguments || parsed.function?.arguments || {};
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
