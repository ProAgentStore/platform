/**
 * What happens to a TURN's words — the last decisions `use-voice.ts` still made inline.
 *
 * `machine.ts` owns whether the mic may act at all; `convo.ts` owns what a word MEANS. Between
 * them sat two chains that nothing could reach without mounting the hook in a browser:
 *
 *   - closing a hands-free turn: is it the destructive command, a trailing control word with a
 *     message in front of it, a stop-word, or just speech? (was `finalize`, use-voice.ts)
 *   - releasing a transcript: is it noise, the wrong language, and does it have a recording
 *     worth keeping? (was the top of `emitSend`)
 *
 * Both are ORDER-SENSITIVE, and every ordering in them is a bug someone shipped: scrap is
 * judged before the splitter because the splitter would keep "let's rewrite the parser" and
 * delete the exchange; the noise gate runs before the language gate so silence never earns a
 * "say that again" nudge; a zero-byte recording must not mint an audio key, because its upload
 * 400s and its replay 404s. Inline, those orderings were assertable only by reading them.
 *
 * No React, no browser — the hook keeps the side effects and this decides what they should be.
 */

import { isNoiseTranscript } from "./audio.js";
import { commandStateFor, matchVoiceCommand, splitTrailingCommand, stripStopWord, transcriptLanguageMismatch, type VoiceCommand, type VoiceCommandWords } from "./convo.js";
import { storedDictation } from "./machine.js";
import { applyVocabulary, type VocabularyCorrection } from "./vocabulary.js";

/**
 * The whole utterance the user has said SO FAR in this capture — the accumulated finals plus
 * the fragment in hand.
 *
 * Only browser dictation accumulates: it emits a result per phrase, so the turn is the sum of
 * them. A Whisper transcript is ALREADY the whole turn (the clip is uploaded once), so
 * prepending the buffer there would say everything twice — and the buffer is not even cleared
 * on that path. Outside hands-free nothing is buffered at all. Three call sites re-derived
 * this conditional; they now cannot disagree about what "so far" means.
 */
export function utteranceSoFar(s: { pending: string; text: string; handsFree: boolean; isWhisper: boolean }): string {
	const pending = s.handsFree && !s.isWhisper ? s.pending : "";
	return `${pending} ${s.text}`.trim();
}

/** A command that takes effect immediately and does NOT consume the turn — the user said it at
 *  the end of a message they still want sent ("run the tests, mute"). */
export type ImmediateCommand = Extract<VoiceCommand, "mute" | "unmute" | "exit">;

/**
 * What closing a hands-free turn does.
 *
 * `scrap` and `repeat` CONSUME the turn — there is nothing left to send, by different logic:
 * scrap matches whole-utterance only (so there is no message half), and repeat asks to hear the
 * LAST reply, which sending a new message first would replace.
 *
 * `send` and `none` both carry the command to apply FIRST and whether to leave afterwards, so a
 * turn can be all three things at once: "run the tests, mute" mutes and sends, "next" sends
 * nothing and leaves, "check the logs, next" does both in that order — the message belongs to
 * the agent being left, so it goes before the departure.
 */
export type FinalizedTurn =
	| { action: "scrap" }
	| { action: "repeat" }
	| { action: "send"; text: string; command: ImmediateCommand | null; switchAfter: boolean }
	| { action: "none"; command: ImmediateCommand | null; switchAfter: boolean };

/**
 * Decide what a finished hands-free turn IS. Shared by the Whisper path, the silence timer and
 * the max-duration timer, so all three close a turn identically.
 *
 * The order is the content:
 *   1. `scrap` (#342) — BEFORE the splitter, which deliberately does not know the word.
 *      Judged on this whole, finished utterance and only when the consumer enabled it; with it
 *      off, "scrap that" is ordinary speech and gets sent, which is the conservative half.
 *   2. the trailing control word — applied, with what came before it KEPT as the message.
 *   3. the stop-word — stripped from whatever survived step 2.
 * A turn that was only a command leaves nothing to send, and says so rather than sending "".
 */
export function planFinalizedTurn(
	msg: string,
	cfg: {
		commandsEnabled: boolean;
		/** The consumer can act on a delete (#342). Off ⇒ the phrase is never a command. */
		canScrap: boolean;
		/** The consumer can move to another agent (#277). */
		canSwitch: boolean;
		muted: boolean;
		words?: VoiceCommandWords;
		lang?: string;
		stopWords?: string[];
	},
): FinalizedTurn {
	if (
		cfg.commandsEnabled &&
		cfg.canScrap &&
		matchVoiceCommand(msg, cfg.words, cfg.lang, commandStateFor("final", { muted: cfg.muted, canScrap: true })) === "scrap"
	) {
		return { action: "scrap" };
	}
	let body = msg;
	let command: ImmediateCommand | null = null;
	let switchAfter = false;
	if (cfg.commandsEnabled) {
		const split = splitTrailingCommand(msg, cfg.words, cfg.lang, { muted: cfg.muted, canSwitch: cfg.canSwitch });
		body = split.text;
		if (split.command === "repeat") return { action: "repeat" };
		if (split.command === "mute" || split.command === "unmute" || split.command === "exit") command = split.command;
		else if (split.command === "next") switchAfter = true;
	}
	const text = stripStopWord(body, cfg.stopWords).text.trim();
	return text ? { action: "send", text, command, switchAfter } : { action: "none", command, switchAfter };
}

/** The dictation gate's answer to "did real words happen this turn?", read at the moment of the
 *  decision. Null where there is no gate at all (browser-dictation mode, iOS Safari). */
export type GateReading = { isAlive: boolean; heardSpeech: boolean } | null | undefined;

/**
 * What a NOISE rejection costs the user (#377) — `pass` (it wasn't noise), or a rejection that
 * either keeps the words or discards them, and in both cases says what to record about it.
 *
 * `keep` says the words must SURVIVE; it does not say where. On the send path that is the pending
 * bubble, marked `failed` with `note` on it; on the recover paths it is the composer. Both are
 * the same contract read on different surfaces: the user decides what happens to their speech,
 * and they can only decide while it is still on screen.
 */
export type NoiseRejection =
	| { action: "pass" }
	| { action: "keep"; note: string; report: string }
	| { action: "discard"; report: string };

/** Shown on the failed bubble under "Not transcribed" — the reason, not a status. */
const NOISE_NOTE = "Came back as noise, so nothing was sent — these are the words heard live.";
/** Fixed strings: `reportClientError` de-dups on source+message, so a burst collapses to one row
 *  instead of flooding the log. What differs per turn belongs in the context, not here. */
const NOISE_KEPT = "voice turn rejected as noise — the live capture was kept";
const NOISE_DISCARDED = "voice turn rejected as noise — nothing was heard, discarded";

/**
 * Decide what a noise verdict DOES to the turn behind it.
 *
 * `isNoiseTranscript` answers one question — "is this text junk?" — and every caller read a yes
 * as "nothing was said". Those are different claims, and the difference is the whole bug: the
 * rejected turn was cleared, taking the bubble, the live capture #319 went to trouble to keep,
 * and any record that a turn had happened at all. The user watched their own words appear and
 * then vanish, and there was no message, no trace event and no error row to confirm it with.
 *
 * The gate already knows which claim is true. If a PROVEN-ALIVE browser-dictation gate heard real
 * words this turn then the user spoke and the transcriber failed to render it — a `failed` turn,
 * not an empty one, which is exactly the status `reduceDictation` documents as "the words we DID
 * hear must survive so nothing is silently lost". Same trust rule as `endOfTurnAction`: a gate
 * that never ran vouches for nothing.
 *
 * A missing gate therefore `discard`s, deliberately. Where there is no gate there is no live
 * capture either — in Whisper mode the recorder produces nothing until the clip uploads — so
 * "keeping the words" would leave a bubble reading "(nothing was captured)" on screen: a dead
 * affordance over a turn nobody took. Noise rejection stays exactly as it was (#332); what
 * changes is only what a rejection costs.
 */
export function planNoiseRejection(text: string, cfg: { transcribePrompt?: string; gate?: GateReading } = {}): NoiseRejection {
	if (!isNoiseTranscript(text, cfg.transcribePrompt)) return { action: "pass" };
	if (!cfg.gate?.isAlive || !cfg.gate.heardSpeech) return { action: "discard", report: NOISE_DISCARDED };
	return { action: "keep", note: NOISE_NOTE, report: NOISE_KEPT };
}

/**
 * What to do with a transcript that is about to become a message: drop it (and why), or send it
 * — with the live capture beside it and, only when there is really a recording, an audio key.
 */
export type SendPlan =
	| { action: "drop"; reason: "noise" | "language" }
	| {
			action: "send";
			text: string;
			/** What the LIVE recognizer heard, when it is worth keeping beside the transcript. */
			dictation?: string;
			/** Mint a turn id and upload the clip. False ⇒ send the text alone. */
			attachAudio: boolean;
			/** Words the vocabulary pass rewrote (#373), so the caller can show them. Empty when
			 *  nothing was touched, which is the overwhelmingly common case. */
			corrections: VocabularyCorrection[];
	  };

/**
 * Gate a finished transcript on its way to `onSend`.
 *
 * Noise FIRST: "you", ".", "Thank you." off silence or echo — and, with the bias prompt in
 * hand, our own vocabulary read back (#332). A dropped turn is not a failure to report, so it
 * must not reach the language check and raise a "didn't catch your language" nudge for words
 * nobody said.
 *
 * Language SECOND (#126): a transcript detected as a language other than the configured one is
 * a mis-detection, and sending it made the agent reply in a language the user never chose.
 * Dropped with a nudge to repeat — never an automatic language switch.
 *
 * `attachAudio` is deliberately three conditions, not one: a recording exists, it has BYTES, and
 * there is an instance to store it against. A zero-byte blob still minted an audio key, whose
 * upload answers 400 and whose replay answers 404 — a turn that looks replayable and is not.
 *
 * VOCABULARY LAST (#373), and only on a transcript that has already survived both gates. Ordering
 * it before the noise gate would let a correction turn a near-miss INTO an exact bias term and get
 * the turn dropped as an echo (#332) — a rewrite that swallows a message is strictly worse than
 * the mishearing it was trying to fix. `dictation` is compared against the CORRECTED text, so a
 * turn whose only difference from the live capture was a spelling fix stops carrying a "what was
 * heard" toggle that shows the same sentence twice.
 */
export function planSend(
	text: string,
	cfg: {
		/** What the live recognizer heard for this turn (`""` when there was no live view). */
		heard: string;
		transcribePrompt?: string;
		confirmLanguage: boolean;
		lang: string;
		/** Size of the recorded clip in bytes (0 when there is none). */
		audioBytes: number;
		/** Present ⇒ the clip has somewhere to be stored. */
		instanceId?: string;
		/** The user's vocabulary + the platform's derived terms (#372/#373). */
		vocabulary?: string[];
	},
): SendPlan {
	if (isNoiseTranscript(text, cfg.transcribePrompt)) return { action: "drop", reason: "noise" };
	if (cfg.confirmLanguage && transcriptLanguageMismatch(text, cfg.lang)) return { action: "drop", reason: "language" };
	const fixed = applyVocabulary(text, cfg.vocabulary || []);
	return {
		action: "send",
		text: fixed.text,
		dictation: storedDictation(cfg.heard, fixed.text) ?? undefined,
		attachAudio: cfg.audioBytes > 0 && !!cfg.instanceId,
		corrections: fixed.corrections,
	};
}
