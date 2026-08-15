/**
 * How a board card's ONE-LINE detail is composed and cut (#568).
 *
 * PURE — no D1, no Env. The two writers that produce a card's `description` (`delegation.ts` and
 * `coding-board.ts`) each did the same thing with it: `note.slice(0, 300)`. That is a blind PREFIX
 * of a sentence whose most important clause is at the END, and it produced this, measured on card
 * `deleg-ae7fa3f2` of instance `bd43f4de`:
 *
 *   > outcome: failed — run error: Too many API requests by single Worker invocation. To configure
 *   > this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits
 *   > | Acts: pushed directly to the trunk origin main; pushed directly to the trunk origin main;
 *   > pushed directly to th
 *
 * Exactly 300 characters, ending mid-word, with no marker. The run had performed FIFTEEN
 * irreversible acts — fourteen pushes to `origin main` and one recursive delete, all confirmed as
 * `act.consequential` rows in the trace — and the card named two of them, as what reads like a
 * finished sentence. The full text was on the same row the whole time, under `reasoning`, which no
 * generic reader takes a card's detail from.
 *
 * ── The two rules this module exists to hold
 *
 *  1. THE COUNT GOES FIRST, AND IT IS NEVER THE THING THAT GETS CUT. The 300 characters were being
 *     spent, in order, on the outcome, a raw Cloudflare error, 81 characters of Wrangler docs URL,
 *     and only then the acts — so the least useful content displaced the record of thirteen pushes
 *     to `main`. {@link actHeadline} states how many acts there were and how many were
 *     irreversible before anything else, so a reader can tell 15 from 2 out of the first thirty
 *     characters. This is `subordinate-payload.ts`'s roster rule ("a caller must never be able to
 *     receive a partial roster that looks whole") applied to a card, and it is what lets the count
 *     survive the SECOND trim `subordinate-payload.ts` puts this string through at 80 characters.
 *
 *  2. A CUT SAYS SO. `tool-result-cap.ts` already made this decision for the tool log and states
 *     why: "a failure marks its cut, because the sentence it is cutting is an instruction and a
 *     silently truncated instruction is how this started." A truncated list of irreversible pushes
 *     to `main` is the same class of sentence. Every cut here carries `…`, and the ellipsis is
 *     inside the budget — the result is never longer than `max`.
 *
 * `repo-policies.ts:367` is the existing precedent for the budgeting itself: it reserves room for
 * the attribution it must keep rather than trimming the composed string. That file has its own
 * `MAX_DESCRIPTION = 300`; it is a separate card family with no acts, and folding it in here is a
 * change to what its cards say, so it is deliberately left alone.
 */

/** A board card's one-line detail budget, in characters. The board and MCP both render this. */
export const CARD_DETAIL_MAX = 300;

/** What joins the lead to the note. Matches `runOutcomeNote`'s own segment separator. */
const SEP = " | ";

/**
 * Characters the lead may never take from the note.
 *
 * The note is why the card is where it is ("outcome: failed — run error: …"); the lead is what the
 * run did. Both belong, so neither is allowed to starve the other — the ordering and the budget
 * are the fix, not dropping one of them.
 */
const NOTE_FLOOR = 120;

/** The most a lead can occupy, so {@link NOTE_FLOOR} is always available to the note. */
const LEAD_MAX = CARD_DETAIL_MAX - SEP.length - NOTE_FLOOR;

const ELLIPSIS = "…";

/**
 * Cut to at most `max` characters INCLUDING the marker.
 *
 * `tool-result-cap.ts` appends the ellipsis outside its budget because its budget is advisory.
 * Here it is not: the caller composes several of these into one 300-character field, so a cut that
 * overran by one character per segment would put the composed string over the cap it exists to
 * respect.
 */
export function cutTo(text: string, max: number): string {
	if (max <= 0) return "";
	if (text.length <= max) return text;
	if (max <= ELLIPSIS.length) return ELLIPSIS;
	return `${text.slice(0, max - ELLIPSIS.length)}${ELLIPSIS}`;
}

/** One act, reduced to what a card headline needs. Structurally satisfied by `ActItem`. */
export interface CardAct {
	/** One sentence naming the act, its subject and whether it was observed to succeed. */
	summary: string;
	/** Can this be walked back? False is the reason a supervisor is being shown it. */
	irreversible: boolean;
}

/** How the tail of an over-long tally is counted rather than dropped. */
const more = (n: number) => `; and ${n} more`;

/**
 * What a run DID, as a COUNT and a tally — the fact a 300-character prefix kept losing.
 *
 * Identical summaries are COLLAPSED with a multiplier, which is the other half of why the observed
 * card was so wasteful: it spent 120 of its 300 characters writing "pushed directly to the trunk
 * origin main" three times. `14× pushed directly to the trunk origin main` says more in a third of
 * the space, and it is the shape the acts actually had.
 *
 * Irreversible groups are named first, for the reason `summarizeActs` orders the same way: when a
 * run pushes eleven branches and merges one, the merge is the sentence.
 *
 * Returns null for a run with no observed acts — never a padded "no consequential acts", which is
 * a claim this cannot make: a raw engine reports nothing, so silence means "not observed".
 *
 * The count is "acts recorded for this run", not "acts this run took". `actsInWindow` reads at most
 * 25, and this cannot see past that; it is the same array `summarizeActs` already counts "and N
 * more" from, so the two surfaces agree about the same bound rather than disagreeing about it.
 */
export function actHeadline(acts: readonly CardAct[]): string | null {
	if (!acts.length) return null;
	const irreversible = acts.filter((a) => a.irreversible).length;
	const count = `${acts.length} act${acts.length === 1 ? "" : "s"}`;
	const qualifier =
		irreversible === 0 ? "" : irreversible === acts.length ? ", all irreversible" : `, ${irreversible} irreversible`;
	const head = `${count}${qualifier}`;

	// Stable sort, so the Map's insertion order puts every irreversible group ahead of every
	// reversible one — the tally is built from the iteration order, not re-sorted afterwards.
	const groups = new Map<string, number>();
	for (const act of [...acts].sort((a, b) => Number(b.irreversible) - Number(a.irreversible))) {
		groups.set(act.summary, (groups.get(act.summary) ?? 0) + 1);
	}
	const pieces = [...groups].map(([summary, n]) => (n > 1 ? `${n}× ${summary}` : summary));

	const shown: string[] = [];
	let used = head.length + 2; // ": "
	for (let i = 0; i < pieces.length; i++) {
		const gap = shown.length ? 2 : 0; // "; "
		// Room is reserved for the "and N more" this loop would owe if it stopped here, so the tally
		// can never fit by silently dropping the count of what it left out.
		const reserve = i < pieces.length - 1 ? more(pieces.length - i - 1).length : 0;
		if (used + gap + pieces[i].length + reserve > LEAD_MAX) break;
		shown.push(pieces[i]);
		used += gap + pieces[i].length;
	}
	if (!shown.length) {
		// One summary longer than the whole budget. Cut it rather than drop the tally entirely — but
		// only if enough survives to name anything; otherwise the count alone is the honest answer.
		const room = LEAD_MAX - used - (pieces.length > 1 ? more(pieces.length - 1).length : 0);
		if (room < 12) return head;
		shown.push(cutTo(pieces[0], room));
		used += room;
	}
	const rest = pieces.length - shown.length;
	return `${head}: ${shown.join("; ")}${rest > 0 ? more(rest) : ""}`;
}

/**
 * Compose a card's detail: the lead in full, then as much of the note as the budget allows.
 *
 * The lead is bounded by {@link LEAD_MAX} before the note is measured, so the note's floor is
 * guaranteed rather than negotiated — a caller cannot pass a lead that starves it.
 */
export function cardDetail(note: string, lead?: string | null, max = CARD_DETAIL_MAX): string {
	const head = (lead ?? "").trim();
	const body = (note ?? "").trim();
	if (!head) return cutTo(body, max);
	const kept = cutTo(head, Math.min(LEAD_MAX, max));
	const room = max - kept.length - SEP.length;
	if (!body || room <= 0) return kept;
	return `${kept}${SEP}${cutTo(body, room)}`;
}
