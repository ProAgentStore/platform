/**
 * An MCP tool result is `{ content: [{type:"text", text}, …], isError? }`. Flatten the text
 * parts into one string; when that string is itself JSON (the common case — servers return
 * structured payloads as JSON text), parse it so a pipeline `$ref` can read fields off it
 * (e.g. the session id a create-style tool hands back). `structuredContent` wins when present.
 */
export interface McpImageArtifact {
	type: "image";
	data: string;
	mimeType: string;
}

/** Keep image blocks structurally separate from text. Callers must explicitly authorise
 * where those bytes go; silently folding them into a transcript leaks both memory and data. */
export function extractToolResult(result: unknown): { data: unknown; isError: boolean; images: McpImageArtifact[] } {
	if (!result || typeof result !== "object") return { data: result, isError: false, images: [] };
	const r = result as Record<string, unknown>;
	const isError = r.isError === true;
	const parts = Array.isArray(r.content) ? r.content : [];
	const images: McpImageArtifact[] = parts
		.filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
		.flatMap((p) => p.type === "image" && typeof p.data === "string" && typeof p.mimeType === "string"
			? [{ type: "image" as const, data: p.data, mimeType: p.mimeType }]
			: []);
	if (r.structuredContent !== undefined) return { data: r.structuredContent, isError, images };
	const text = parts
		.filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
		.map((p) => (typeof p.text === "string" ? p.text : ""))
		.filter(Boolean)
		.join("\n");
	if (!text) return { data: r.content ?? r, isError, images };
	const t = text.trim();
	if (t.startsWith("{") || t.startsWith("[")) {
		try {
			return { data: JSON.parse(t), isError, images };
		} catch {
			/* not JSON — return the text */
		}
	}
	return { data: text, isError, images };
}
