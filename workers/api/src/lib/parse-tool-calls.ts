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
			continue;
		}
	}
	return results;
}

/** Find the index of the closing brace that matches the opening brace at `start`. */
function findMatchingBrace(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escape) { escape = false; continue; }
		if (ch === "\\") { escape = true; continue; }
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
	return rawCalls.map((tc: unknown) => {
		const call = tc as Record<string, unknown>;
		if (call.function && typeof call.function === "object") {
			const fn = call.function as Record<string, unknown>;
			const args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments as string) : fn.arguments || {};
			return { name: fn.name as string, arguments: args as Record<string, unknown> };
		}
		return { name: call.name as string, arguments: (call.arguments || {}) as Record<string, unknown> };
	}).filter((tc) => tc.name);
}
