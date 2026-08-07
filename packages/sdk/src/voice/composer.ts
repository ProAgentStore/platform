/**
 * What the message composer shows while voice is running — the ONE place that answers "does the
 * voice stack put text in the input box?".
 *
 * It does not. There is exactly ONE live-speech surface per chat, and it is the pending
 * `dictation` bubble in the thread (#281): the bubble keeps the words through transcription, keeps
 * them when transcription FAILS, and carries the status chrome ("Speaking…", "Transcribing…",
 * "Not transcribed", a note, a Dismiss) that a `<textarea value=…>` cannot express at all.
 *
 * The composer used to be a SECOND surface, bound to the hook's notice string back when that
 * string also carried speech. #281 moved the words out and left the binding behind, so from then
 * on the input lit up accent-italic and went read-only **only on a mic error**, and in hands-free
 * it asserted its "Listening…" placeholder for the whole utterance while showing nothing (#364).
 * Two surfaces, one of them dead and the styling implying it was the live one.
 *
 * So the rule is stated once, here, and pinned by `composer.test.ts` (which also scans the
 * front-end trees so no consumer can quietly re-bind speech or a notice into an input value):
 *
 *   - `value` is the user's TYPED draft. Never speech, never a notice.
 *   - `readOnly` means **voice owns this turn** — an utterance is in flight. A notice is not
 *     ownership: a mic error must not lock someone out of typing the message themselves. Nor is a
 *     FAILED utterance, which is precisely when they are most likely to want to.
 *   - `notice` is handed BACK to be rendered as its own small banner next to the controls.
 */
import type { Dictation } from "./machine.js";

export interface ComposerBinding {
	/** What the textarea shows: the typed draft, and nothing the voice stack produced. */
	value: string;
	/** An utterance is in flight — hold the box and the send action until the turn resolves. */
	readOnly: boolean;
	/** The transient notice (mic error / wrong-language nudge). Render it BESIDE the composer,
	 *  never as its value. Empty string when there is nothing to say. */
	notice: string;
}

export function resolveComposer(s: {
	/** What the user has typed. */
	draft: string;
	/** The utterance in flight, from `useVoice().dictation`. */
	dictation: Dictation | null;
	/** The transient notice, from `useVoice().notice`. */
	notice: string;
}): ComposerBinding {
	return {
		value: s.draft,
		readOnly: !!s.dictation && s.dictation.status !== "failed",
		notice: s.notice,
	};
}
