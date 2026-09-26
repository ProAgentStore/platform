/**
 * Command-versus-content, as three verdicts rather than one (#457 step 2).
 *
 * Voice carries two streams over one channel: content for the agent and control for the app. The
 * splitter used to answer both questions with one `{ command, text }` — fire the command, and strip
 * its words from the message — though the two have wildly asymmetric costs. An unwanted mute is one
 * tap to undo; a truncated sentence is lost. One verdict forced the expensive rule onto the cheap
 * action, which is why `"don't forget to mute"` used to fire nothing at all.
 *
 * Pure and dependency-free: `convo.ts` owns the phrase tables and decides WHICH words are mute
 * phrases; this file owns what the verdicts are and when the uncertain case parks.
 */
import type { VoiceCommand } from "./convo.js";

/**
 * The verdict for a finished utterance.
 *
 *  - `fire` — the command applies and `text` is what remains once its words are stripped. Reached
 *    only on strong evidence: the whole utterance, a trailing multi-word phrase, a repeated word
 *    (#456), or a command that already fired during capture (#457 step 3, where `command` is null
 *    because it must not fire twice).
 *  - `park` — the command applies, but its words cannot be confidently told from content, so
 *    `text` is the WHOLE utterance, to be handed to the composer rather than sent or dropped.
 *  - `none` — no command; `text` is the message.
 */
export type CommandSplit =
	| { verdict: "fire"; command: VoiceCommand | null; text: string }
	| { verdict: "park"; command: "mute"; text: string }
	| { verdict: "none"; command: null; text: string };

/** Words that turn a trailing "mute" into its opposite — "don't mute", "do not mute", "never mute". */
const NEGATORS = new Set(["dont", "not", "never", "no", "doesnt", "didnt", "wont", "cant", "shouldnt"]);

/**
 * Does this NORMALISED utterance end in one of `singleMutePhrases`, with content before it and no
 * negation right in front of it? The negation guard is the price of firing on weaker evidence:
 * `"don't mute"` asks for the opposite, and firing there is a mute the user explicitly refused.
 */
export function parksOnTrailingMute(norm: string, singleMutePhrases: readonly string[]): boolean {
	const toks = norm.split(" ").filter(Boolean);
	if (toks.length < 2 || !singleMutePhrases.includes(toks[toks.length - 1])) return false;
	return !NEGATORS.has(toks[toks.length - 2]);
}
