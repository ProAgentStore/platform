/**
 * SPELLING TOLERANCE for spoken text — "is this the same word, written differently?"
 *
 * Two recognisers read every voice turn (browser Web Speech live, then Whisper on the clip) and
 * they disagree about spelling constantly: `colour`/`color`, `ok`/`okay`, `HeartFull`/`Heartful`.
 * Every part of the stack that compares a transcript against something else needs the same answer
 * to that question, so it is asked in exactly one place:
 *
 *   - {@link dictationDiverged} (machine.ts) — do the two readings share any word at all? A
 *     spelling variant must COUNT as shared, or every ordinary disagreement reads as divergence.
 *   - {@link applyVocabulary} (#373) — is this token a near-miss of a word the user told us they
 *     say? If so, write it the way they write it.
 *
 * ── The tolerance, and why it is this tight
 *
 * Correcting a word the user really said is worse than leaving a mishearing: the mishearing is
 * visibly wrong, the correction is invisibly wrong. So the allowance scales with length and stays
 * below the point where two different short words collide:
 *
 *     ≤3 letters   0 edits   `go`/`no`, `it`/`is` are DIFFERENT words
 *     4–6 letters  1 edit    `color`/`colour`, `Heartful`/`Heartfull`
 *     ≥7 letters   2 edits   `transcript`/`transcripts`, `Kubernetes`/`Kubernetes`
 *
 * …plus a same-first-letter rule, because the first phoneme is the one a recogniser is least
 * likely to invent and the cheapest way to stop `send`→`bend`-class swaps.
 *
 * **What this deliberately CANNOT do.** #373 opens with `Timo` → `tmux`. Those are 3 edits apart
 * over 4 letters — 75% different — and no honest edit-distance rule reaches it without also
 * reaching words that have nothing to do with each other. That case is fixed BEFORE the
 * transcript exists, by biasing the decoder (`prompt.ts`), not after it by rewriting words. The
 * post-hoc pass is for the near-misses; the bias prompt is for the mishearings.
 */

/** Bounded Levenshtein: exact up to `max`, and returns `max + 1` for anything further away.
 *  Bounded because the answer is only ever compared against a small threshold, and the early
 *  exit is what keeps this cheap enough to run per token per turn. */
export function editDistance(a: string, b: string, max: number): number {
	if (a === b) return 0;
	if (Math.abs(a.length - b.length) > max) return max + 1;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		let best = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
			row.push(v);
			if (v < best) best = v;
		}
		// Every remaining alignment passes through this row, so once the whole row is beyond the
		// budget the answer is too. This is the bound doing its work.
		if (best > max) return max + 1;
		prev = row;
	}
	return prev[b.length];
}

/** How many edits apart two words of this length may be and still be the same word. */
function tolerance(len: number): number {
	if (len <= 3) return 0;
	if (len <= 6) return 1;
	return 2;
}

/**
 * Are these two words the same word, allowing for how differently two engines spell it?
 *
 * Both sides are expected already lowercased (callers run {@link normalizeSpeech} or its word
 * splitter first). The length used for the tolerance is the SHORTER one, so a long term cannot
 * buy itself a wider allowance against a short token.
 */
export function nearWord(a: string, b: string): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	if (a[0] !== b[0]) return false; // the first phoneme is the one least likely to be invented
	const max = tolerance(Math.min(a.length, b.length));
	if (max === 0) return false;
	return editDistance(a, b, max) <= max;
}

/** One word the correction pass rewrote, so a caller can SHOW it. Silently rewriting somebody's
 *  words is the failure mode this feature must not become. */
export interface VocabularyCorrection {
	from: string;
	to: string;
}

/** A token and the separators around it, so a replacement keeps the sentence intact. */
const TOKEN = /\p{L}[\p{L}\p{N}]*/gu;

/**
 * Rewrite near-misses of the user's own vocabulary, in place, conservatively (#373).
 *
 * This is the half of the feature that works on the BROWSER recogniser. Web Speech has no
 * steerable grammar — `SpeechGrammarList` is specced and Chrome's default recogniser ignores it —
 * so a vocabulary can only reach that path after the fact. The transcriber gets the same words as
 * a bias prompt instead, which is the better mechanism where it is available.
 *
 * The user authors ONE flat list of words they SAY, never a from→to mapping: nobody knows in
 * advance that "tmux" will come back as "Timo", and asking someone to enumerate their own
 * mishearings is a guaranteed-incomplete chore.
 *
 * ── The guards, and what each one refuses
 *
 *  1. **Whole tokens only.** Never a multi-word span, never a substring of a longer word. A
 *     replacement that can straddle a word boundary can change a sentence's structure.
 *  2. **{@link nearWord}'s tolerance**, which is 0 edits below four letters — so `go`/`no` and
 *     `it`/`is` can never be rewritten into each other by a short vocabulary entry.
 *  3. **Ambiguity is left alone.** A token near TWO different terms is a token we cannot claim to
 *     know the answer for; guessing between them is exactly the invisible-wrongness this must not
 *     produce.
 *  4. **A token that already IS a term is untouched**, so nothing is "corrected" to itself and a
 *     user who says a word correctly never sees it move.
 *
 * ── What is NOT guarded, honestly
 *
 * There is no dictionary check, so a real English word one edit from a vocabulary term can be
 * rewritten (add `Sentry` and someone saying "sentry" gets the capital). Shipping a dictionary per
 * language to a browser bundle costs more than the failure does, and the list is the user's own
 * proper nouns by construction — but this is the reason corrections are RETURNED rather than
 * applied invisibly, and the reason the tolerance is as tight as it is.
 */
export function applyVocabulary(
	text: string,
	terms: string[],
): { text: string; corrections: VocabularyCorrection[] } {
	if (!text || !terms.length) return { text, corrections: [] };
	// The canonical spelling per lowercased term, and the set of terms to match against.
	const canonical = new Map<string, string>();
	for (const t of terms) {
		const term = t.trim();
		// Multi-word terms are matched by the bias prompt, not here: rewriting a span is guard 1.
		if (!term || /\s/.test(term) || !/^\p{L}[\p{L}\p{N}]*$/u.test(term)) continue;
		if (!canonical.has(term.toLowerCase())) canonical.set(term.toLowerCase(), term);
	}
	if (!canonical.size) return { text, corrections: [] };
	const corrections: VocabularyCorrection[] = [];
	const out = text.replace(TOKEN, (token) => {
		const lower = token.toLowerCase();
		if (canonical.has(lower)) {
			// Guard 4: it IS a term. Restore the user's spelling of it (that is the whole point of
			// storing `HeartFull` rather than `heartfull`) but never call that a correction.
			return canonical.get(lower) as string;
		}
		let hit: string | null = null;
		for (const [key, spelling] of canonical) {
			if (!nearWord(lower, key)) continue;
			if (hit) return token; // guard 3: near two terms → we do not know which, so neither
			hit = spelling;
		}
		if (!hit) return token;
		corrections.push({ from: token, to: hit });
		return hit;
	});
	return { text: out, corrections };
}
