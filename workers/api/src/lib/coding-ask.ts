/**
 * The parts of an `ask_owner` the ticket page renders (#1129) — the uncut question beside the
 * phone-sized one, and a question holding several decisions as one option list per decision.
 */
import { clipMarked } from "./clip-marked.js";

/** Options past these bounds are dropped (#960). */
export const ASK_OPTIONS_MAX = 6;
export const ASK_OPTION_CHARS = 80;

/** The uncut question the ticket page can expand to (#1129) — bounded, and marked if cut even so. */
export const ASK_QUESTION_FULL_MAX = 4000;
export const ASK_PARTS_MAX = 4;

/** One decision of a multi-part `ask_owner` (#1129): its own question and its own options. */
export interface AskPart {
	question: string;
	options: string[];
}

/**
 * The parts of an `ask_owner` (#1129), cleaned: each a phone-sized question with 2–6 options (the
 * `askOptions` rules), at most four. A part with no usable options is dropped, and fewer than two
 * parts is not a multi-part question — the caller falls back to `options`.
 */
export function askParts(raw: unknown): AskPart[] {
	const out: AskPart[] = [];
	for (const p of Array.isArray(raw) ? raw : []) {
		const question = typeof p?.question === "string" ? clipMarked(p.question.replace(/\s+/g, " ").trim(), ASK_OPTION_CHARS * 2, { within: true }) : "";
		const options = askOptions(p?.options);
		if (!question || !options.length) continue;
		out.push({ question, options });
		if (out.length === ASK_PARTS_MAX) break;
	}
	return out.length >= 2 ? out : [];
}

/**
 * The options of an `ask_owner`, cleaned: strings, trimmed, de-duplicated, at most six, each short.
 * A comma becomes a semicolon because the console reads the options back out of a `from: a, b, c`
 * list (`RunDetail.tsx`) — one option must not become two. Fewer than two is a free-form question.
 */
export function askOptions(raw: unknown): string[] {
	const out: string[] = [];
	for (const o of Array.isArray(raw) ? raw : []) {
		if (typeof o !== "string") continue;
		const v = o.replace(/,/g, ";").replace(/\s+/g, " ").trim();
		if (!v || v.length > ASK_OPTION_CHARS || out.includes(v)) continue;
		out.push(v);
		if (out.length === ASK_OPTIONS_MAX) break;
	}
	return out.length >= 2 ? out : [];
}

/**
 * The question as it is announced off the card (#1025's issue comment, the Coder Brain) — with a
 * multi-part ask's decisions listed under it (#1129), since those readers take one text, not parts.
 */
export function askAnnouncement(ask: { question: string; parts?: AskPart[] }): string {
	if (!ask.parts?.length) return ask.question;
	return [ask.question, ...ask.parts.map((p, i) => `${i + 1}. ${p.question} — ${p.options.join(" / ")}`)].join("\n");
}
