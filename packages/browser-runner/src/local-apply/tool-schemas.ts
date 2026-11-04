const QUOTE_PROP = { type: "string", description: "The exact text from the owner's profile, answers or materials that this answer comes from. Required; the value must appear in it." };

/** A browser tool's schema with `source_quote` added — the CLI must say where an answer comes from. */
export function withQuote(schema: unknown, required: boolean, extra: Record<string, unknown> = {}): unknown {
	const s = (schema && typeof schema === "object" ? schema : { type: "object" }) as { properties?: Record<string, unknown>; required?: string[] };
	return { ...s, type: "object", properties: { ...(s.properties ?? {}), source_quote: QUOTE_PROP, ...extra }, ...(required ? { required: [...(s.required ?? []), "source_quote"] } : {}) };
}
