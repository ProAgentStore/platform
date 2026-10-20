/**
 * The parts of an `ask_owner` the ticket page renders (#1129) — the uncut question beside the
 * phone-sized one, and a question holding several decisions as one option list per decision.
 */
import { clipMarked } from "./clip-marked.js";

/** At most six options (#960); a seventh is not offered, and the uncut ask says so (#1224). */
export const ASK_OPTIONS_MAX = 6;
/**
 * An option longer than this is CLIPPED with a marker, never dropped (#1224). It used to be 80 and a
 * drop: the Pilot wrote three options as one-sentence explanations, all three vanished, and the owner
 * was asked a three-way choice twice with `options: []`. The console's buttons wrap, so a sentence is fine.
 */
export const ASK_OPTION_MAX = 300;
/** One part's question (#1129) — phone-sized, cut with a marker. */
export const ASK_PART_QUESTION_MAX = 160;

/** Bounds on an `ask_owner` (#960) — a phone-sized question; a longer one is cut WITH a marker. */
export const ASK_QUESTION_MAX = 300;

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
		const question = typeof p?.question === "string" ? clipMarked(p.question.replace(/\s+/g, " ").trim(), ASK_PART_QUESTION_MAX, { within: true }) : "";
		const options = askOptions(p?.options);
		if (!question || !options.length) continue;
		out.push({ question, options });
		if (out.length === ASK_PARTS_MAX) break;
	}
	return out.length >= 2 ? out : [];
}

/**
 * The options of an `ask_owner`, cleaned: strings, trimmed, de-duplicated, at most six, a long one
 * clipped with a marker (#1224) — never dropped for its length.
 * A comma becomes a semicolon because the console reads the options back out of a `from: a, b, c`
 * list (`RunDetail.tsx`) — one option must not become two. Fewer than two is a free-form question.
 */
export function askOptions(raw: unknown): string[] {
	const out: string[] = [];
	for (const o of Array.isArray(raw) ? raw : []) {
		if (typeof o !== "string") continue;
		const v = o.replace(/,/g, ";").replace(/\s+/g, " ").trim();
		const clipped = clipMarked(v, ASK_OPTION_MAX, { within: true });
		if (!v || out.includes(clipped)) continue;
		out.push(clipped);
		if (out.length === ASK_OPTIONS_MAX) break;
	}
	return out.length >= 2 ? out : [];
}

/**
 * The question as it is announced off the card (#1025's issue comment, the Coder Brain) — with a
 * multi-part ask's decisions listed under it (#1129), since those readers take one text, not parts.
 */
export function askAnnouncement(ask: { question: string; parts?: AskPart[]; fullQuestion?: string }): string {
	// Whatever did not survive cleaning is in the uncut ask (#1224) — the issue comment is where the owner reads it.
	const base = ask.fullQuestion || ask.question;
	// An uncut ask whose parts lost something already lists them as written.
	if (!ask.parts?.length || (ask.fullQuestion && ask.parts.every((p) => ask.fullQuestion?.includes(p.question)))) return base;
	return [base, ...ask.parts.map((p, i) => `${i + 1}. ${p.question} — ${p.options.join(" / ")}`)].join("\n");
}

/**
 * The ask as the Pilot wrote it (#1224): the question, then its parts and its options, one per line,
 * verbatim. What the owner can expand to — and the only record of it, since a parked run's pane is
 * gone (`coding_terminal` held zero snapshots for TradePort run 78971d03). Non-strings are left out.
 */
export function askRawText(question: string, options: unknown, parts: unknown): string {
	const lines = [question];
	const list = (o: unknown) => (Array.isArray(o) ? o.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : []);
	(Array.isArray(parts) ? parts : []).forEach((p, i) => {
		lines.push(`${i + 1}. ${typeof p?.question === "string" ? p.question.trim() : ""}`);
		for (const o of list(p?.options)) lines.push(`   - ${o}`);
	});
	for (const o of list(options)) lines.push(`- ${o}`);
	return lines.join("\n");
}

/** The same ask, for comparing: what cleaning does to text that LOST nothing (comma → semicolon, spaces). */
export const askComparable = (raw: string): string => raw.replace(/,/g, ";").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();

/** An `ask_owner` as the loop parks it (#960): `field` is the question; the rest is what the owner answers from. */
export interface AskNeedsInput {
	field: string;
	why?: string;
	options?: string[];
	fullQuestion?: string;
	parts?: AskPart[];
	/** It introduces choices (ends with ":") and gave none (#1224) — the loop sends it back once. */
	incomplete?: boolean;
}

/** The Pilot's `ask_owner` call → the question the run parks on, or a handoff when it asked nothing. */
export function askOwnerDecision(a: Record<string, unknown>): { needsInput: AskNeedsInput } | { stuck: { why: string } } {
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	const asked = str(a.question).trim();
	const question = clipMarked(asked, ASK_QUESTION_MAX, { within: true });
	if (!question) return { stuck: { why: "Asked the owner a question but did not say what it was." } };
	const parts = askParts(a.parts);
	const options = parts.length ? [] : askOptions(a.options);
	// The question stays phone-sized everywhere it travels (#960); the ticket page can also show it
	// uncut (#1129). And whatever cleaning took — a cut question, a clipped option, a part without two
	// options — the ask as written rides beside it (#1224), so nothing the Pilot asked is lost unseen.
	const raw = askRawText(asked, parts.length ? undefined : a.options, a.parts); // options given beside usable parts are ignored, not lost
	// The lists ride along only when THEY lost something; otherwise their buttons already say it all.
	const listsLost = askComparable(askRawText("", parts.length ? undefined : a.options, a.parts)) !== askComparable(askRawText("", options, parts));
	const fullQuestion = listsLost ? clipMarked(raw, ASK_QUESTION_FULL_MAX, { within: true }) : question !== asked ? clipMarked(asked, ASK_QUESTION_FULL_MAX, { within: true }) : undefined;
	// "Two decisions needed:" with nothing after it (#1224). When the decisions were in the call but
	// did not survive, the question becomes the ask as written; when they never were, the loop sends
	// the call back once (`incomplete`) before parking it as a free-form question.
	const introducesChoices = !options.length && !parts.length && /:\s*$/.test(asked);
	const field = introducesChoices && fullQuestion ? clipMarked(raw, ASK_QUESTION_MAX, { within: true }) : question;
	return { needsInput: { field, why: str(a.why).trim(), options, ...(fullQuestion ? { fullQuestion } : {}), ...(parts.length ? { parts } : {}), ...(introducesChoices && !fullQuestion ? { incomplete: true } : {}) } };
}
