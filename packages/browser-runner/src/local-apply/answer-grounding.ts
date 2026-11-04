import { normalize } from "../local-artifact/engine.js";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Is `value` grounded? The quote must be verbatim text from the owner's sources, and the value must
 * appear in the quote as a whole phrase ("No" is not found inside "Notice"). Returns the refusal,
 * or null. Pure, so the rule is tested as a rule.
 */
export function groundingRefusal(value: string, quote: unknown, grounding: string): string | null {
	const q = typeof quote === "string" ? normalize(quote) : "";
	if (q.length < 2) return "Every answer needs a source_quote: the exact text from the owner's profile, answers or materials that this value comes from.";
	if (!normalize(grounding).includes(q)) return "The source_quote is not text from the owner's profile, answers or materials. Quote them exactly, or call request_answer.";
	const v = normalize(value);
	if (!v) return "The value is empty.";
	if (!new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(v)}(?![\\p{L}\\p{N}])`, "u").test(q)) return `"${value.slice(0, 80)}" does not appear in the source_quote. Use the owner's value as written, or call request_answer.`;
	return null;
}
