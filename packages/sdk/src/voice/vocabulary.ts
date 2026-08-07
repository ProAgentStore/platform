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
