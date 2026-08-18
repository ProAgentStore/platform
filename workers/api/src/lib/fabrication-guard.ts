/**
 * The two promises about what reaches a real employer's form, moved out of the prompt (#643).
 *
 * ── What was wrong
 *
 * `applySystemPrompt` states both of them as sentences to the model and nothing else:
 *
 *   "- NEVER invent data. Use ONLY the candidate values above…"
 *   "- Demographic / EEO / voluntary self-identification questions … ALWAYS choose
 *     \"Decline to self-identify\" … Never guess these."
 *
 * `job.candidate` was read in exactly ONE place in the whole Worker — the line that renders it
 * into that prompt. Between the brain choosing a `type` and `callRunner("/browser/act", …)` there
 * was a single gate, `dryRunBlockReason`, and it inspects `action`/`name`/`ref`/`key` only. No
 * code had ever compared a typed value against the candidate's actual data.
 *
 * Every other safety property in this subsystem is enforced at runtime *because the prompt
 * version was found insufficient*: dry-run (prompt AND `commitBlockReason`), read-only ("a
 * read-only agent that its caller could talk out of being read-only would just be a prompt with
 * extra steps"), cancellation, single-flight, budget. Fabrication is in the same category with a
 * larger blast radius — a submitted application carrying an invented phone number or a guessed
 * race answer is not recoverable, and the owner had no signal it happened.
 *
 * ── What this is
 *
 * A pure pre-filter at the act layer, beside `dryRunBlockReason` and returning through the same
 * channel: a string is handed BACK to the brain instead of performing the action. It never
 * rewrites the value — a fabricated value that gets typed and then corrected is still a value the
 * model chose, and a silent correction would be a second invisible behaviour on the very path
 * this exists to make visible — and it always names the move that IS available
 * (`request_user_info`, which has pause/resume machinery behind it, or the decline option the
 * prompt already enumerates).
 *
 * ── Only what is mechanically decidable
 *
 * "Did the model invent this?" is undecidable for a free-text screening answer, so two narrow
 * checks that are string comparisons against data already in hand:
 *
 *  1. An EEO / demographic `select` or `check` whose chosen value is neither a decline option nor
 *     something the user supplied.
 *  2. A `type` into a phone / email / salary control whose text appears nowhere in the candidate
 *     values or the answers the user has given.
 *
 * ── What "sourced" means, precisely
 *
 * {@link knownValues} is the whole definition: the candidate block, the answers the user gave to
 * an ask-and-hold ticket, their job preferences, their cover note, their Special Instructions and
 * any live message they sent mid-run. All six are things the USER wrote or was explicitly asked
 * for. `cacheHint` is deliberately NOT in it: #633 withholds a prior run's typed values on purpose
 * (one ATS host serves many employers), so treating them as sourced would re-open exactly the leak
 * that closed.
 *
 * ── Why postcode is NOT guarded, though the ticket lists it
 *
 * `user_profile` HAS a `postalCode` column, and `profileToCandidate` builds `location` from
 * city/state/country only — so the postcode never reaches the prompt. Every postcode the model
 * types is therefore unsourced *by construction*, and guarding it would pause every application
 * with an address block. Worse, it would pause it AGAIN on every later run: `guessProfileKey`
 * maps "postcode"/"postal"/"zip" to the standard key `postalCode`, `profileCustomAnswers` skips
 * standard keys, and `profileToCandidate` drops it — so the answer the user gives is invisible to
 * the next application and the guard asks forever.
 *
 * That is the criterion for the whole list, not a special case: guard a field only where the
 * answer, once asked for, comes BACK into the prompt. `phone` → `phone`, `salary` →
 * `salaryExpectation`, `e-mail` → `email` all round-trip through `profileToCandidate`; postcode,
 * city, state and country do not, and city/state/country at least arrive inside `location`.
 * Fixing the postcode round-trip is a change to the profile→candidate mapping, not to a guard.
 *
 * ── Known limits, stated rather than hidden
 *
 *  • The vocabularies here are English. #627 is the record of what an English-only guard costs,
 *    and the shape of the cost is different in each direction: there, a missing word let a French
 *    submit through; here, an unrecognised control name means the field is simply not guarded —
 *    the state everything was in before this existed. A non-English DECLINE option on an
 *    English-named control is the one false-refusal path, and it is answerable: the model can call
 *    `request_user_info`.
 *  • An EEO answer the user DID give, worded differently from the option the ATS offers ("No" vs
 *    "I am not a protected veteran"), is refused. That direction is chosen deliberately: the
 *    prompt's own exemption is "unless a candidate value above EXPLICITLY provides it", and a
 *    loose match on a protected characteristic can assert the opposite of what someone said.
 *  • `select` is guarded for EEO only, never for a number. A salary BAND ("$120k–$140k") is a
 *    legitimate choice from options the page offered, not a figure the model made up, and a
 *    numeric rule over it would refuse the correct band on every form that uses one.
 */

import { resolveSnapshotElement } from "./commit-guard.js";

/** The part of a `BrowserAction` this guard reads. Declared structurally rather than imported
 *  from `apply-loop.ts` — that module would then import this one back, and `import-graph.test.ts`
 *  fails on a static cycle even when it is type-only (the same reason `commit-guard.ts` declares
 *  its own `GuardedAction`). */
export interface ValuedAction {
	action?: string;
	name?: string;
	ref?: string;
	text?: string;
}

/** Everything the user actually supplied, as the apply job carries it. Structurally a subset of
 *  `ApplyJob`, so the workflow passes the job straight in. */
export interface CandidateFacts {
	candidate?: {
		fullName?: string;
		email?: string;
		phone?: string;
		location?: string;
		linkedin?: string;
		portfolio?: string;
		workAuthorization?: string;
		salaryExpectation?: string;
	};
	/** Values the user supplied mid-run via ask-and-hold (field label → value). */
	providedAnswers?: Record<string, string>;
	coverNote?: string;
	preferences?: { targetRoles?: string; targetLocations?: string; workType?: string; openToRelocation?: string };
	/** The user's own standing rules for this agent (KB → Rules & Tips). Their words. */
	specialInstructions?: string;
	/** A live free-text message the user sent while the agent was running. Their words. */
	userHint?: string;
}

/** The fixed-shape identity fields a typed value is checked against. See the docstring for why
 *  the list is exactly this and not the address block. */
export type GuardedField = "phone" | "email" | "salary";

const FIELD_PATTERNS: Array<[GuardedField, RegExp]> = [
	["email", /\be-?mail\b/i],
	["phone", /\b(phone|mobile|cell|telephone|tel)\b/i],
	["salary", /\b(salary|compensation|remuneration|pay rate|hourly rate|expected pay|desired pay)\b/i],
];

/** Questions whose answer is a protected characteristic. `sex` is word-bounded so "Middlesex"
 *  does not match; `self-identif*` catches "Voluntary Self-Identification of Disability", which
 *  is the exact heading the US EEO forms use. */
const EEO_RE =
	/\b(gender|sex|sexual orientation|race|ethnic\w*|hispanic|latino|veteran|disab\w*|self[- ]?identif\w*|demographic\w*|eeo)\b/i;

/** The answers that decline to answer. The prompt already enumerates the first three; the rest
 *  are the phrasings the same ATS forms use for the same option. */
const DECLINE_RE =
	/decline|prefer not|prefer to not|rather not|don'?t wish|do not wish|don'?t want|do not want|not to (say|answer|disclose|identify)|choose not|opt out|no answer|not disclos\w*|undisclosed|unspecified|not specified|\bn\/?a\b|not applicable/i;

/** A dropdown that has not been answered yet. Choosing one of these states nothing, so it is not
 *  a fabrication and refusing it would only cost a step. */
const PLACEHOLDER_RE = /^\s*(-{1,3}|select(\s+(one|an?\s+\w+))?\.{0,3}|choose(\s+one)?\.{0,3}|please select\.{0,3})\s*$/i;

/** Container roles whose accessible name carries the QUESTION for the options inside them. A
 *  `<fieldset><legend>Gender</legend>` renders as `group "Gender"`; an explicit ARIA one renders
 *  as `radiogroup`. Deliberately not `form`/`region`/`generic`: those wrap whole pages, and a
 *  page-level name would put every control on the form inside the EEO test. */
const GROUPISH_ROLE_RE = /^(group|radiogroup|fieldset)$/i;

const digits = (s: string) => s.replace(/[^0-9]/g, "");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every value the user supplied, in one list — the operative definition of "sourced". See the
 *  module docstring for what is in it and, more importantly, what is not. */
export function knownValues(job: CandidateFacts): string[] {
	const out: string[] = [];
	for (const v of Object.values(job.candidate ?? {})) if (typeof v === "string" && v.trim()) out.push(v);
	for (const v of Object.values(job.providedAnswers ?? {})) if (typeof v === "string" && v.trim()) out.push(v);
	for (const v of Object.values(job.preferences ?? {})) if (typeof v === "string" && v.trim()) out.push(v);
	// The user's own prose. A rule like "my mobile is 0400 111 222, use it" is the user handing
	// the agent a value as surely as the profile does, and a guard that ignored it would refuse
	// the one thing the user explicitly asked for.
	for (const v of [job.coverNote, job.specialInstructions, job.userHint]) if (v?.trim()) out.push(v);
	return out;
}

/**
 * Do these two strings name the same phone number?
 *
 * Compared on digits alone, because the ONE thing a phone field varies is punctuation: `+61 412
 * 345 678`, `0412 345 678` and `(04) 1234 5678` are one number, and a guard that refused two of
 * the three would break more applications than it saved.
 *
 * Two rules, in order:
 *  • containment — the stored number written without its country code, or with an extension
 *    appended, still contains (or is contained by) the other.
 *  • an 8-digit suffix — `+61 412 345 678` (`61412345678`) and `0412345678` share no prefix at
 *    all, and the national trunk `0` versus a country code is exactly the difference. Eight is
 *    the shortest subscriber number in common use, so a shorter comparison would start matching
 *    unrelated numbers; both sides must have at least that many digits to use it.
 */
export function samePhone(a: string, b: string): boolean {
	const x = digits(a);
	const y = digits(b);
	if (!x || !y) return false;
	if (x.includes(y) || y.includes(x)) return true;
	return x.length >= 8 && y.length >= 8 && x.slice(-8) === y.slice(-8);
}

/**
 * The numbers a string actually states, canonicalised.
 *
 * The first version of this guard compared the whole ALPHANUMERIC text against the stored value,
 * which made `120000 AUD` sourced and `AUD 120,000 per annum` — the same figure, the wording a
 * model naturally produces — a refusal. The harm this guard exists to stop is a FIGURE the
 * candidate never gave, so the figure is what gets compared and the words around it are noise.
 *
 *  • thousands separators are collapsed BEFORE tokenising, or "120 000" reads as 120 and 0;
 *  • a `k`/`m` suffix is a multiplier, so "120k" and "120000" are one number.
 */
export function numbersIn(s: string): string[] {
	const flat = s
		.replace(/(\d),(?=\d{3}(?!\d))/g, "$1")
		.replace(/(\d)\s(?=\d{3}(?!\d))/g, "$1");
	const out: string[] = [];
	for (const m of flat.matchAll(/(\d+(?:\.\d+)?)\s*([km])?\b/gi)) {
		const mult = m[2] ? (m[2].toLowerCase() === "k" ? 1000 : 1_000_000) : 1;
		const n = Number(m[1]) * mult;
		if (Number.isFinite(n)) out.push(String(n));
	}
	return out;
}

/**
 * Is every figure in `value` a figure the user gave?
 *
 * ALL of them, not one of them: `$110,000 – $130,000` typed against a stored `120000` is two
 * numbers the candidate never stated, and accepting it because a third one nearby matched would
 * put an invented band on a real application. It also needs at least one — a value with no
 * recognisable figure is handled by the caller's precondition, not here.
 */
export function numbersAreSourced(value: string, known: string[]): boolean {
	const want = numbersIn(value);
	if (!want.length) return false;
	const have = new Set(known.flatMap(numbersIn));
	return want.every((n) => have.has(n));
}

/** Does this exact word/phrase appear in one of the user's values? Word-bounded on purpose:
 *  a plain `includes` would read "Male" out of a stored "Female" and let the guard through on
 *  the opposite of what the user said — and would read a fabricated `e@x.com` out of a real
 *  `someone@x.com`, which is the same mistake pointing the other way. */
export function phraseAppearsIn(value: string, known: string[]): boolean {
	const v = value.trim();
	if (!v) return false;
	const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(v)}(?![\\p{L}\\p{N}])`, "iu");
	return known.some((k) => re.test(k));
}

const indentOf = (l: string) => l.length - l.replace(/^[\t ]+/, "").length;

/**
 * The names of the container(s) this element sits inside — how an EEO RADIO becomes detectable.
 *
 * A `select` names the question ("Gender") and carries the answer in `text`. A radio does not: the
 * page renders `group "Gender"` with `radio "Male"` beneath it, so the action alone says only
 * "Male" and the question lives one level up in the ARIA tree. Without this, the highest-harm case
 * in the ticket — a guessed gender or race on a real form — was out of reach whenever the ATS used
 * radios, which Greenhouse and Workday both do.
 *
 * Used ONLY to decide whether a question is demographic, never to classify a `type` field: a
 * `group "Salary history"` wrapping a `textbox "Year"` would otherwise turn a date into a salary
 * and refuse it. Bounded to `max` ancestors so a page-level container cannot drag every control
 * into the test.
 */
export function ancestorGroupNames(snapshot: string | undefined | null, ref: string | undefined, max = 4): string[] {
	const id = (ref ?? "").trim();
	if (!snapshot || !id) return [];
	const lines = snapshot.split("\n");
	const start = lines.findIndex((l) => l.includes(`[ref=${id}]`));
	if (start < 0) return [];
	const out: string[] = [];
	let depth = indentOf(lines[start]);
	for (let j = start - 1; j >= 0 && out.length < max; j--) {
		const ind = indentOf(lines[j]);
		if (ind >= depth) continue; // a sibling or one of its descendants, not an ancestor
		depth = ind;
		const m = lines[j].match(/([a-zA-Z]+)\s+"([^"]*)"/);
		if (m && GROUPISH_ROLE_RE.test(m[1]) && m[2].trim()) out.push(m[2]);
		if (ind === 0) break;
	}
	return out;
}

/** Which guarded field is this control, if any? Both the PAGE's name for the element and the name
 *  the model claimed are consulted — the page's first, for #627's reason (the runner locates by
 *  `ref` and ignores `name`, so `name` is a self-report), and the claim second so a stale or
 *  ref-less snapshot still gets a verdict. */
export function guardedFieldOf(names: string[]): GuardedField | null {
	for (const [kind, re] of FIELD_PATTERNS) {
		if (names.some((n) => n && re.test(n))) return kind;
	}
	return null;
}

/** Is this value one the user actually supplied for a control of this kind? */
function isSourced(kind: GuardedField, text: string, known: string[]): boolean {
	if (kind === "phone") return known.some((k) => samePhone(text, k));
	if (kind === "email") return phraseAppearsIn(text, known);
	return numbersAreSourced(text, known);
}

/**
 * Why this action must not reach the page — the message handed back to the brain INSTEAD of
 * performing it, in the same channel `dryRunBlockReason` uses. `null` means "go ahead".
 *
 * Refusal, never rewriting: the loop reports it as a failed action, so the value is recorded as
 * refused and the brain gets to choose again (which it demonstrably does — the dry-run block has
 * been steering it to `finish(ready)` on the same channel since #627).
 */
export function fabricationBlockReason(
	action: ValuedAction | null | undefined,
	job: CandidateFacts,
	snapshot?: string | null,
): string | null {
	if (!action) return null;
	const claimed = String(action.name ?? "").trim();
	const pageName = (resolveSnapshotElement(snapshot, action.ref)?.name ?? "").trim();
	const names = [pageName, claimed];
	const label = pageName || claimed;
	const known = knownValues(job);

	if (action.action === "select" || action.action === "check") {
		// A `select` names the QUESTION and carries the chosen option in `text`. A `check` targets
		// the option itself, so its own name is the ANSWER — which is why the question has to come
		// from the containing group (see {@link ancestorGroupNames}) or, on a form with no
		// fieldset, from an option label that carries the characteristic itself ("I am a protected
		// veteran"). The page's own label is preferred over the model's for the same reason it is
		// everywhere else here.
		const chosen = action.action === "select" ? String(action.text ?? "").trim() : label;
		if (!chosen || PLACEHOLDER_RE.test(chosen)) return null;
		const asking = [...names, ...ancestorGroupNames(snapshot, action.ref)];
		if (!asking.some((n) => n && EEO_RE.test(n))) return null;
		if (DECLINE_RE.test(chosen)) return null;
		// The prompt's own exemption: "unless a candidate value above explicitly provides it".
		if (phraseAppearsIn(chosen, known)) return null;
		return `REFUSED — "${chosen}" would state a protected characteristic (gender / race / ethnicity / veteran status / disability) about the candidate, and they have not told you it. Choose the decline option on this control instead — "Decline to self-identify" / "I don't wish to answer" / "Prefer not to say" / "I do not wish to disclose". If this control genuinely has no such option, call request_user_info(field:"${label || "this question"}", why:"a self-identification question with no decline option") and let the user answer it themselves. Do not pick a different guess.`;
	}

	if (action.action !== "type") return null;
	const text = String(action.text ?? "").trim();
	if (!text) return null;
	const kind = guardedFieldOf(names);
	if (!kind) return null;
	// Preconditions that keep this off the values it cannot judge:
	//  • phone — fewer than 6 digits is a fragment (a country code, an area code, an extension),
	//    not a number anyone could have fabricated into a form. It also keeps a "Mobile app
	//    experience (years)" box, which the phone vocabulary matches on the word "Mobile", out of
	//    a guard that has nothing to say about it.
	//  • email — no "@" means the box is being used for something else ("N/A", a note).
	//  • salary — no digit means it is prose ("Negotiable", "Open to discussion"), which is an
	//    opinion rather than an invented figure. The harm this guard exists to stop is a NUMBER
	//    the candidate never gave.
	if (kind === "phone" && digits(text).length < 6) return null;
	if (kind === "email" && !text.includes("@")) return null;
	if (kind === "salary" && !/[0-9]/.test(text)) return null;
	if (isSourced(kind, text, known)) return null;
	const ask = kind === "salary" ? "salary expectation" : kind;
	return `REFUSED — that value does not appear anywhere in the candidate's data or in the answers the user has given you, so typing it into "${label || kind}" would be inventing it. Do NOT retype it, and do not try a different format of it. Call request_user_info(field:"${ask}", why:"required by ${label || `the ${kind} field`} on this form") — the application pauses, the user supplies the real value, and it resumes.`;
}
