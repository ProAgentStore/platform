/**
 * ONE normaliser for spoken text (#334), shared by every matcher in the voice stack.
 *
 * ── Why this file exists
 *
 * There were two. `convo.ts` stripped `.,!?¿¡。，！？、` before matching commands and stop-words;
 * `audio.ts` stripped a much wider set — hyphens, dashes, quotes, brackets, CJK brackets —
 * before deciding a transcript was noise. Two functions that MUST agree about what punctuation
 * is, and did not, with the stricter one guarding the cheap decision and the looser one guarding
 * the user-visible one.
 *
 * The instance: the owner had `"stop stop"` configured as a stop-word. Whisper renders a repeated
 * word as a hyphenated compound *sometimes* — a formatting choice, not a transcription
 * difference — so `"Stop-stop."` normalised to `stop-stop`, matched nothing, and was sent to the
 * agent as a chat message while the mic stayed live. `"Stop stop."` on the very next turn worked.
 * That is the reported "it works, then it doesn't": a near-miss on punctuation the user cannot
 * control and cannot see.
 *
 * ── Why UNICODE CATEGORIES and not a longer ASCII list
 *
 * A longer character class would have fixed the hyphen and left the next one: en/em dashes
 * (`–` `—`), the non-breaking hyphen `‑`, the ideographic and Arabic full stops, the invisible
 * soft hyphen. This stack is already script-aware in every other respect — the noise filter
 * counts glyphs in any script, commands ship in ten languages, the language-confirmation guard
 * matches by `\p{Script=…}` — so the normaliser is the one place still thinking in ASCII.
 * `\p{P}` is every punctuation category in every script, which is the actual rule we meant.
 *
 * ── The three classes, and why they are not treated the same
 *
 *   PUNCTUATION (`\p{P}`) → a SPACE, then whitespace collapses. A hyphen JOINS two words that
 *     were spoken separately, so deleting it would give `stopstop`, which matches nothing either.
 *     Spacing is what makes `"Stop-stop."`, `"Stop, stop."` and `"Stop stop."` one utterance.
 *
 *   ELISION MARKS (apostrophes) → DELETED. They join letters INSIDE a word: `don't` must become
 *     `dont`, not `don t`, or a phrase list would have to carry both spellings. Both sides of
 *     every comparison run through here, so the choice only has to be consistent — and this is
 *     the one that keeps French `l'écoute` a single token in either rendering.
 *
 *   FORMAT CHARACTERS (`\p{Cf}`) → DELETED. Zero-width joiners, the BOM, and the soft hyphen are
 *     invisible by definition; a match must never turn on a glyph nobody can see.
 *
 * NFC first, because a decomposed `é` and a composed `é` are the same spoken word and STT engines
 * do not agree on which they emit.
 */

/** Apostrophes and their typographic variants — elision marks, deleted rather than spaced. */
const ELISION = /['’‘`´ʻʼ]/g;
/** Invisible format characters (ZWJ/ZWNJ, BOM, soft hyphen): never part of a match. */
const INVISIBLE = /\p{Cf}/gu;
/** Every punctuation category, every script — dashes, quotes, brackets, CJK and inverted marks. */
const PUNCTUATION = /\p{P}/gu;

/**
 * Normalise a transcript (or a configured phrase) for matching: lowercase, NFC, invisible and
 * elision marks removed, all other punctuation reduced to a space, whitespace collapsed.
 *
 * Used by the command matcher, the stop-word splitter and the noise filter alike, so a change
 * here changes all of them together — which is the point.
 */
export function normalizeSpeech(text: string): string {
	return (text || "")
		.toLowerCase()
		.normalize("NFC")
		.replace(INVISIBLE, "")
		.replace(ELISION, "")
		.replace(PUNCTUATION, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Strip trailing punctuation from an ORIGINAL (un-normalised) string, so a slice of it keeps its
 * casing and internal spacing. The normalised copy is for deciding; this is for cutting.
 */
export function trimTrailingPunctuation(text: string): string {
	return text.replace(/[\p{P}\s]+$/u, "");
}

/**
 * Fold a run of the SAME thing said twice or more down to one (#456).
 *
 * The reported failure: `"Mute, mute, mute, mute, mute"` matched NOTHING and was delivered to the
 * agent as a chat turn. One "mute" works; two or more work less well than one, because the
 * whole-utterance rule wants exact equality and `"mute mute mute mute mute"` is not `"mute"`. That
 * is the worst possible shape, because **repetition is what a user does when the first attempt
 * appears not to have worked** — the natural recovery action was the one guaranteed to fail, and
 * it published the attempt into the conversation. ADR 0001 M1 says mute is reachable in every
 * phase; there it was unreachable precisely when the user was trying hardest to reach it.
 *
 * Repetition is the disambiguator, and it is the reason this is safe. A bare trailing "mute" is
 * genuinely ambiguous — `"don't forget to mute"` is prose — which is why the single-word rule
 * exists and stays. A REPEATED bare command word is not ambiguous: no English sentence ends
 * `"…, mute mute"`, and no sentence IS `"mute mute mute mute mute"`.
 *
 * IT LIVES BESIDE {@link normalizeSpeech} AND IS DELIBERATELY NOT PART OF IT, which is why it is
 * in this file: this is where a reader would be tempted to fold the repetition once and for all.
 * `normalizeSpeech` is shared with the transcript comparison and the noise filter, where a
 * legitimately doubled word ("very very") must survive. Its callers in `convo.ts` fold only while
 * a command match is being EVALUATED, only as a second attempt after the raw transcript has been
 * tried, and never over a phrase the user has explicitly bound — so it can add a match, never
 * remove one, and it cannot outrank a binding (#385).
 *
 * Two rules, because "adjacent identical tokens" only sees a script that writes spaces:
 *  1. adjacent identical whitespace-separated tokens → one;
 *  2. a single spaceless token that IS one unit repeated → that unit, which is how a repeated
 *     `"停"`/`"ミュート"` arrives when the engine emits no separator. Only ever consulted against a
 *     command phrase list, so an ordinary word that happens to be its own halves ("murmur",
 *     "bonbon") folds to something that matches nothing and changes no outcome.
 */
export function collapseRepeatedRuns(normalized: string): string {
	const out: string[] = [];
	for (const tok of normalized.split(" ")) {
		if (tok && out[out.length - 1] !== tok) out.push(tok);
	}
	const s = out.join(" ");
	if (s.includes(" ") || s.length < 2) return s;
	for (let len = 1; len <= s.length / 2; len++) {
		if (s.length % len === 0 && s.slice(0, len).repeat(s.length / len) === s) return s.slice(0, len);
	}
	return s;
}
