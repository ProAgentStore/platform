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
 *
 * `seeded` is honoured with or WITHOUT a `continuity` block (#738). A brief is a fact about the
 * engine; a decision is a fact about the request, and the platform makes the first without making
 * the second every time it relocates a session (`startSessionOnRunner`, ADR 0005). Requiring both
 * is what made the relocation banner unreachable on the only path that relocates.
 */
export function continuityNotice(continuity: unknown, seeded?: unknown): OpenNotice | null {
	const block = continuity && typeof continuity === "object" ? (continuity as SessionContinuityPayload) : null;
	const mode = block?.mode === "resume" || block?.mode === "fresh" ? block.mode : null;
	// The reason belongs to a DECISION, so it is only concatenated when there was a recognisable
	// one. An unknown `mode` from a newer or malformed API carries a sentence this renderer cannot
	// place, and appending it to the seeded banner would attach a stranger's clause to a fact.
	const why = mode && typeof block?.reason === "string" ? block.reason.trim() : "";
	const tail = why ? ` — ${why}` : "";
	// SEEDED (#693, ADR 0005) — a third outcome, and it is checked FIRST, above even the presence of
	// a `continuity` block, because it is a fact about what the engine HAS while `mode` is what the
	// server asked for. That ordering is the whole of #738: the case this branch was written for —
	// a session relocated to another machine and briefed on arrival (#694) — has no `continuity`
	// object at all, because a re-attach decides nothing. Keying the render off the decision made
	// the one path that needs the banner the one path that could never reach it.
	//
	// `seeded: true` on a `resume` means the machine could not honour the request and took the brief
	// instead; the banner has to describe the engine in front of the user, not the intention.
	//
	// Still `warn`, not `quiet`. The tone rule this file already states is that a fresh start is the
	// SURPRISE — the open where the next thing the user types has no antecedent — and a brief does
	// not remove that, it softens it. Reading as reassurance would be the ADR's forbidden claim
	// ("never… as if it never died") rendered as a colour.
	//
	// "was given" and "reconstructed", deliberately: the engine did not remember any of this, it was
	// told. A user who believes the engine remembers will not re-state the thing it is missing.
	if (seeded === true) {
		return {
			id: "inst-coding-continuity",
			tone: "warn",
			text: `Started a fresh conversation${tail}. It was given a brief of this repo's recent history, reconstructed from ProAgentStore's record — so it knows what was going on, but not the details.`,
		};
	}
	if (!mode) return null;
	if (mode === "resume") return { id: "inst-coding-continuity", tone: "quiet", text: `Picking up where you left off${tail}.` };
	// "conversation", never "session". #257 and #408 spent real effort removing "session" from
	// the words a user has to know and #695 removed the last of it from this surface, so
	// reintroducing it in the one line a user is most likely to read would undo all of it.
	// The opener is the only wording this function owns; `reason` is opaque server text,
	// concatenated as given and never inspected.
	return { id: "inst-coding-continuity", tone: "warn", text: `Started a fresh conversation${tail}.` };
}

/** Everything worth saying about one open, in the order it should be read. */
export function openNotices(open: { notice?: unknown; continuity?: unknown; seeded?: unknown } | null | undefined): OpenNotice[] {
	const out: OpenNotice[] = [];
	// The engine first: which binary is running is a precondition for caring what it remembers.
	const engine = typeof open?.notice === "string" ? open.notice.trim() : "";
	if (engine) out.push({ id: "inst-coding-reused-engine", tone: "warn", text: engine });
	// `seeded` is what the MACHINE confirmed, and it is a sibling of `continuity` on the response
	// rather than a field inside it for exactly that reason — `continuity` is the decision, and a
	// decision is not an outcome. An older API sends neither and `undefined` reads as "not briefed",
	// which is the honest default: it is what every open did before #693.
	const continuity = continuityNotice(open?.continuity, open?.seeded);
	if (continuity) out.push(continuity);
	return out;
}
