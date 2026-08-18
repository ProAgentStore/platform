// Defense-in-depth secret redaction for UNTRUSTED content that admin views surface
// (agent_events context, MCP-audit tool input/result, coding launch_command). These
// come from tool I/O / user config where a token could end up despite write-time
// guards — so we redact again on read. Not a replacement for not-storing-secrets;
// a second net.

// Keys whose VALUE is a secret regardless of content.
const SECRET_KEY = /(pass(word|wd)?|secret|token|credential|authorization|auth|api[_-]?key|apikey|access[_-]?code|access[_-]?token|refresh[_-]?token|bearer|cookie|session[_-]?(id|token)|private[_-]?key|client[_-]?secret)/i;

// Value shapes that look like a live secret even under an innocent key name.
const SECRET_VALUE = new RegExp(
	[
		"sk-[A-Za-z0-9_-]{16,}", // OpenAI-style
		"sk-ant-[A-Za-z0-9_-]{16,}", // Anthropic
		"gh[pousr]_[A-Za-z0-9]{20,}", // GitHub tokens
		"xox[baprs]-[A-Za-z0-9-]{10,}", // Slack
		"AIza[0-9A-Za-z_-]{20,}", // Google API key
		"eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{4,}", // JWT
		"Bearer\\s+[A-Za-z0-9._-]{12,}", // bearer header
	].join("|"),
	"gi",
);

/** Mask secret-looking substrings in a plain string. */
export function redactText(s: string): string {
	return (s || "").replace(SECRET_VALUE, "[redacted]");
}

export interface RedactOptions {
	/**
	 * Key names exempted from the NAME match above, for a call site that knows a
	 * particular field is an opaque handle rather than a credential (#704). Scoped per
	 * call site on purpose: narrowing `SECRET_KEY` itself would change what all four
	 * consumers store, and some of the things it catches — a stateful MCP server's
	 * `Mcp-Session-Id`, say — genuinely are capabilities.
	 *
	 * An exemption only skips the key-NAME rule. The value-shape net still runs over the
	 * field, so an exempted key holding a real `ghp_…`/JWT/`Bearer …` is still masked.
	 */
	allowKeys?: RegExp;
}

/** Recursively redact an object: secret-named keys → "[redacted]", string values →
 *  value-pattern masked. Bounded depth so a pathological blob can't blow the stack. */
export function redactSecrets(value: unknown, depth = 0, opts: RedactOptions = {}): unknown {
	if (depth > 8) return value;
	if (typeof value === "string") return redactText(value);
	if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1, opts));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			const named = SECRET_KEY.test(k) && !opts.allowKeys?.test(k);
			out[k] = named ? "[redacted]" : redactSecrets(v, depth + 1, opts);
		}
		return out;
	}
	return value;
}

/** Redact a JSON string in place, preserving shape; falls back to text redaction if
 *  it isn't valid JSON. Returns null for null/empty input. */
export function redactJsonString(s: string | null | undefined): string | null {
	if (s == null || s === "") return null;
	try {
		return JSON.stringify(redactSecrets(JSON.parse(s)));
	} catch {
		return redactText(s);
	}
}
