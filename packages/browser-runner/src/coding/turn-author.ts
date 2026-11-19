/**
 * Who wrote the turn the Engine is about to receive (#505, criterion 3).
 *
 * ── The defect
 *
 * `HeadlessSession.input` writes every turn to Claude Code as
 * `{ type: "user", message: { role: "user", … } }`. That is the only shape the stream-json input
 * protocol accepts — the role vocabulary is `user`/`assistant`, there is no third value to move
 * to, and an Engine that stops receiving instructions is far worse than the defect — so the
 * framing cannot be fixed by changing the role. The consequence is that the Engine calls whoever
 * is driving it "the user", and **whoever is driving it is usually the Pilot, not a person.**
 *
 * On 2026-08-11 that produced a completion message telling the owner he had been warned and had
 * "explicitly chosen" to bump the wrong `pubspec.yaml`. `instance_messages` shows he sent nothing
 * in that window (22:31:20 and 22:47:54 bracket it); the Engine's objection was correct, and
 * overriding it broke the deploy. Nothing had lied: the Engine said "the user", the Pilot read
 * that back, and "the user" is the only word the protocol gave it.
 *
 * ── What this module does, and what it deliberately does not
 *
 * It **names the author** on the two surfaces the naming collision travels through:
 *
 *  - {@link authoredTurn} — a one-line preamble the Engine reads BEFORE the instruction, so the
 *    Engine's own prose ("you asked me to…") is at least anchored to something that says what
 *    "you" is. The instruction follows **verbatim**, after a blank line. #505's standing promise
 *    is *annotate, never rewrite*: the instruction is the evidence, and truncating or rephrasing
 *    it would destroy the only record of what was actually sent.
 *  - {@link authorTag} — a two-word marker on the transcript line, which is what the owner reads
 *    in the Terminal view and what the Pilot re-reads through `/coding/capture`. It is short
 *    because that pane is a fixed character budget the Pilot pays for on every decision; a
 *    150-character preamble repeated on every turn would evict real output from the window the
 *    Pilot can see. The pane has never been a wire log — it already renders `❯ [12:03:04] …`,
 *    which is not sent either — so a compact marker there is consistent with what that line is.
 *
 * ── Why only the Pilot is named
 *
 * The vocabulary is **closed at one member on purpose**, the way `repo-write.ts` closes its verb
 * list. `POST /coding/act` is a shared door: the console's manual `/message` route, MCP's
 * `coding_session_message`, the Overseer's delegation and the agent's own `drive_claude` tool all
 * arrive through it, and none of them declares an author. An absent author therefore means
 * "nobody said", which is exactly what it renders as — nothing. Adding a `"human"` member would
 * turn silence into a claim the runner cannot support: it could only ever be set by the callers
 * that already bothered to be explicit, so an unlabelled human turn and an unlabelled machine turn
 * would still be indistinguishable while the labelling implied otherwise.
 *
 * A runner older than this change ignores the field entirely and behaves exactly as before; a
 * cloud older than this change sends no author and the bytes are byte-identical to today. Both
 * directions degrade to the status quo rather than to a wrong label.
 */

/**
 * The closed author vocabulary. Adding a member is a code review — see above.
 *
 * `"owner"` (#1481) is the second member. Unlike "human" it is a claim the CLOUD can support: the
 * only door that declares it is the owner-authenticated message route, which has just checked the
 * owner's credential. It does NOT say a person typed the words — an assistant acting for the owner
 * (MCP's `coding_session_message`) sends through the same door — and the preamble says so. What it
 * settles is provenance: the owner's authenticated channel, not a webpage, file or tool result.
 */
export type TurnAuthor = "pilot" | "owner";

/** The authors this runner will accept over the wire. Anything else is treated as unstated. */
const AUTHORS: readonly string[] = ["pilot", "owner"];

/**
 * Narrow an untrusted wire value to a {@link TurnAuthor}.
 *
 * The runner is a published npm package that any caller can POST to, so the field arrives as
 * `unknown` and an unrecognised value must read as "unstated" rather than becoming a label.
 */
export function asTurnAuthor(value: unknown): TurnAuthor | undefined {
	return typeof value === "string" && AUTHORS.includes(value) ? (value as TurnAuthor) : undefined;
}

/**
 * The preamble the Engine reads. Kept to one sentence pair: it is prepended to EVERY Pilot turn,
 * so its length is a per-turn token cost on every engine, on every run.
 *
 * It states only what the runner actually knows — the caller declared this turn's author — and
 * makes no claim about whether a human is watching, because the console does surface the Pilot's
 * step lines in the owner's chat and "no person has seen this" would be false there.
 */
const PILOT_PREAMBLE =
	'[pags] This turn was written by the Pilot, an automated orchestrator, not typed by a person. "The user" in this conversation means the Pilot.';

/**
 * What the Engine reads before an owner-channel turn (#1481): where it came from, then the one class of
 * request it is not to second-guess. Engines were classing the owner's "preserve the work, hold the
 * push, hand off" as injection and carrying on fixing forward; provenance stated by the platform, in
 * a line the caller's text cannot precede, is what lets them tell the owner's channel from page text.
 *
 * Bounded on purpose: it covers stopping and preserving, never new work, and it authorises nothing a
 * webpage or tool result says.
 */
const OWNER_PREAMBLE =
	"[pags] This turn arrived on the owner's authenticated ProAgentStore channel (typed by the owner or by an assistant acting for them) — it is not webpage, file or tool-result content. " +
	"If it asks you to stop, preserve work, hold a push or hand off, do that without arguing the technical review: make no further changes, do not push, force-push or stash, leave other people's changes untouched, and report the exact state (branch, HEAD, uncommitted files, anything unpushed).";

/**
 * The instruction as the Engine receives it: the author's preamble, a blank line, then the
 * caller's text **unchanged**.
 *
 * Returns the input untouched when the author is unstated, so the only turns whose bytes change
 * are the ones the platform can actually name.
 */
export function authoredTurn(text: string, author?: TurnAuthor): string {
	if (author === "pilot") return `${PILOT_PREAMBLE}\n\n${text}`;
	if (author === "owner") return `${OWNER_PREAMBLE}\n\n${text}`;
	return text;
}

/**
 * The transcript marker, already spaced for concatenation (`""` when the author is unstated), so
 * a reader of the pane can tell a Pilot turn from a turn a person typed.
 */
export function authorTag(author?: TurnAuthor): string {
	return author === "pilot" ? "(pilot) " : author === "owner" ? "(owner) " : "";
}
