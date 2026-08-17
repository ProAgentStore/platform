// What an open of a repo TELLS you — pure, so the sentences are testable (#697).
//
// ── The fact that was computed and thrown away
//
// `workers/api/src/lib/coding-session-continuity.ts` decides, on every open, whether the engine
// continues the repo's previous conversation or starts clean, and it goes to deliberate trouble to
// phrase WHY as a sentence a human can read — `describeAge` exists for no other reason than to
// round an age to a unit that reads as a fact. The route returns it as `continuity` on the create
// path. `grep -c continuity CodingTab.tsx` answered 0.
//
// So the two outcomes were indistinguishable on screen: a resumed conversation and a cold one both
// open on the same blank pane. The owner hit exactly that on 2026-08-17 — the resume had WORKED,
// the work was preserved, and the only reasonable conclusion from the screen was that everything
// had been lost. The platform knew, had phrased it, and said nothing.
//
// ── Why `fresh` is louder than `resume`
//
// They are not two values of one fact, they are an expectation and a surprise. `resume` is what a
// user assumes is happening anyway; saying it in a warning colour every time would train them to
// stop reading the banner, and the banner's whole job is to be read on the ONE open where the
// agent has forgotten them. `fresh` is the open where the next thing they type — "now do the same
// for the other two files" — has no antecedent, and they need to know that BEFORE they type it.
// Hence quiet reassurance for one and a warning for the other, from the same shape.
//
// ── Why the reused-engine notice composes rather than competing
//
// Two different things can be true about one open: the server reused a live session running a
// different engine (#549, returned as `notice`), and the continuity policy decided something
// (#697, returned as `continuity`). They answer different questions — WHICH engine you got, and
// WHAT it remembers — so this returns a LIST and the tab renders every entry. Today the API cannot
// actually send both (the reuse path returns early, before a session is created, so it carries no
// `continuity`), and that is precisely the reason not to fold them into one slot: a client that
// overwrites one with the other looks correct for exactly as long as that stays true, and the
// route's early return is not a promise anyone made.

/**
 * How loudly to say it. `quiet` is a plain panel line; `warn` is the tinted, bordered banner
 * #549 already established for "the open did something other than what the button implies".
 */
export type OpenNoticeTone = "warn" | "quiet";

export interface OpenNotice {
	/** DOM id — also the React key, and what the e2e specs address the banner by. */
	id: string;
	tone: OpenNoticeTone;
	text: string;
}

/** The `continuity` block the create-session route returns. Unknown-typed: see {@link continuityNotice}. */
export interface SessionContinuityPayload {
	mode?: unknown;
	resumeFrom?: unknown;
	reason?: unknown;
}

/**
 * The continuity sentence, or null when there is nothing honest to say.
 *
 * Takes `unknown` on purpose. This field arrives from the network, and the two responses that do
 * NOT carry it are both live paths — a reuse, and the create-race loser — so `undefined` is the
 * ordinary case rather than an error. An older API is the same shape. None of those may render a
 * half-sentence, and none of them may throw inside a render.
 *
 * A missing `reason` still gets its headline. The server's contract says the reason is never empty,
 * but "Picking up where you left off." is a true sentence without it, whereas
 * "Picking up where you left off — ." is the garbage that a trailing concatenation produces.
 */
export function continuityNotice(continuity: unknown): OpenNotice | null {
	if (!continuity || typeof continuity !== "object") return null;
	const { mode, reason } = continuity as SessionContinuityPayload;
	if (mode !== "resume" && mode !== "fresh") return null;
	const why = typeof reason === "string" ? reason.trim() : "";
	const tail = why ? ` — ${why}` : "";
	return mode === "resume"
		? { id: "inst-coding-continuity", tone: "quiet", text: `Picking up where you left off${tail}.` }
		: // "conversation", never "session". #257 and #408 spent real effort removing "session" from
			// the words a user has to know and #695 removed the last of it from this surface, so
			// reintroducing it in the one line a user is most likely to read would undo all of it.
			// The opener is the only wording this function owns; `reason` is opaque server text,
			// concatenated as given and never inspected.
			{ id: "inst-coding-continuity", tone: "warn", text: `Started a fresh conversation${tail}.` };
}

/** Everything worth saying about one open, in the order it should be read. */
export function openNotices(open: { notice?: unknown; continuity?: unknown } | null | undefined): OpenNotice[] {
	const out: OpenNotice[] = [];
	// The engine first: which binary is running is a precondition for caring what it remembers.
	const engine = typeof open?.notice === "string" ? open.notice.trim() : "";
	if (engine) out.push({ id: "inst-coding-reused-engine", tone: "warn", text: engine });
	const continuity = continuityNotice(open?.continuity);
	if (continuity) out.push(continuity);
	return out;
}
