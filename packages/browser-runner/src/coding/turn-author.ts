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

/** The closed author vocabulary. One member; adding a second is a code review — see above. */
export type TurnAuthor = "pilot";

/** The authors this runner will accept over the wire. Anything else is treated as unstated. */
const AUTHORS: readonly string[] = ["pilot"];

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
 * The instruction as the Engine receives it: the author's preamble, a blank line, then the
 * caller's text **unchanged**.
 *
 * Returns the input untouched when the author is unstated, so the only turns whose bytes change
 * are the ones the platform can actually name.
 */
export function authoredTurn(text: string, author?: TurnAuthor): string {
	return author === "pilot" ? `${PILOT_PREAMBLE}\n\n${text}` : text;
}

/**
 * The transcript marker, already spaced for concatenation (`""` when the author is unstated), so
 * a reader of the pane can tell a Pilot turn from a turn a person typed.
 */
export function authorTag(author?: TurnAuthor): string {
	return author === "pilot" ? "(pilot) " : "";
}
