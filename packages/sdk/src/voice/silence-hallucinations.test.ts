/**
 * The silence-hallucination set, and the invariant that keeps it able to fire (#400).
 *
 * The reported defect was a missing phrase: Whisper emitted "Thank you for watching!" on
 * near-silence, `isNoiseTranscript` did not recognise it, and the agent answered a turn the owner
 * never took. Adding the string fixes that one transcript. It does not fix the reason nobody
 * noticed the set was incomplete — and the set ALREADY contained the evidence: `"thanks for
 * watching!"` had been sitting in it unreachable, because the lookup normalises the transcript
 * and then compares it against a raw entry.
 *
 * So the phrase list gets tests, and the SHAPE of the list gets a guard. A dead entry is now a
 * failing test rather than a line that reads like protection.
 */
import { describe, expect, it } from "vitest";
import { SILENCE_HALLUCINATION_PHRASES, isNoiseTranscript } from "./audio.js";
import { normalizeSpeech } from "./normalize.js";

describe("silence-hallucination entries are stored in matchable form", () => {
	/**
	 * The guard. `isNoiseTranscript` does `has(normalizeSpeech(text))`, so an entry that is not
	 * its own normalised form is unreachable by construction. RED before this commit on
	 * `"thanks for watching!"`; red again the moment someone adds `"don't forget to subscribe"`
	 * with the apostrophe, which is the same mistake wearing different punctuation.
	 */
	it("every phrase equals its own normalised form", () => {
		const dead = [...SILENCE_HALLUCINATION_PHRASES].filter((p) => normalizeSpeech(p) !== p);
		expect(dead, `unreachable entries — normalizeSpeech() rewrites them, so has() can never hit them: ${dead.join(", ")}`).toEqual([]);
	});

	/**
	 * Whole-utterance matching is what makes a WIDER list safe: a long sentence that merely
	 * contains one of these is untouched, so adding phrases costs no real speech. If this ever
	 * became a substring match, every phrase added here would start eating sentences.
	 */
	it("matches the whole utterance, not a substring of one", () => {
		expect(isNoiseTranscript("thank you for watching")).toBe(true);
		expect(isNoiseTranscript("thank you for watching the deploy, it worked")).toBe(false);
		expect(isNoiseTranscript("say bye to the old runner")).toBe(false);
	});
});

describe("the #400 corpus artefacts are recognised", () => {
	/** The verbatim transcript from the incident, and the variants of the same sign-off. */
	it.each([
		"Thank you for watching!",
		"thank you for watching",
		"Thank you for watching.",
		"Thank you so much for watching!",
		"Thanks for watching!",
		"thanks for watching",
		"Please subscribe.",
		"Subscribe to my channel!",
		"Don't forget to subscribe!",
		"See you in the next video!",
	])("drops %j", (text) => {
		expect(isNoiseTranscript(text)).toBe(true);
	});

	/**
	 * The other half of the rule, and the reason the list is not simply "anything polite".
	 * The platform ships a Language Buddy agent whose users say these words ON PURPOSE, and the
	 * existing comment already makes this point for `谢谢`. A filter that ate them would fail the
	 * exact users it is quietest for — they would look like they were being ignored.
	 */
	it.each(["thanks", "谢谢", "thank you very much", "watching", "subscribe"])("keeps %j", (text) => {
		expect(isNoiseTranscript(text)).toBe(false);
	});
});
