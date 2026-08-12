/**
 * A browser-dictation SPEECH GATE for Whisper ("Smart AI") mode.
 *
 * The problem it solves: Whisper/gpt-4o-transcribe HALLUCINATES words on silence,
 * background noise, or keyboard clicks ("I don't know", "you", "Thank you.") — so the
 * amplitude VAD would record near-nothing, upload it, and the hallucination got sent as
 * a real turn ("I'm not talking and it started working"). Browser SpeechRecognition
 * (Web Speech) does NOT hallucinate on non-speech — it simply returns nothing. So we run
 * it alongside the Whisper recorder purely to answer two questions in real time:
 *
 *   1. "Show me the words as I speak" — live interim text (always-visible dictation).
 *   2. "Did the user actually say real words this turn?" — the gate; if not, the turn is
 *      discarded and never sent to the model (no phantom turn, no "Working").
 *
 * Feature-detected: returns null when SpeechRecognition is unavailable (iOS Safari), where
 * the caller falls back to the amplitude VAD + the noise-transcript filter.
 */

import { isNoiseTranscript } from "./audio.js";
import { isReportableMicError } from "./convo.js";
import { EMPTY_HEARD, type HeardState, heardText, reduceHeard } from "./machine.js";
import { micHandoff, nextMicOwner } from "./mic-handoff.js";
import { isBenignRecognizerEnd, type MicErrorDetail, type MicFailureRun, micErrorDetail, NO_MIC_FAILURES, noteMicFailure, planMicRestart } from "./mic-retry.js";

interface SpeechRecognitionAlternativeLike {
	readonly transcript: string;
}
interface SpeechRecognitionResultLike {
	readonly isFinal: boolean;
	readonly length: number;
	readonly [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
	readonly resultIndex: number;
	readonly results: { readonly length: number; readonly [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((e: SpeechRecognitionEventLike) => void) | null;
	onerror: ((e: { error: string }) => void) | null;
	onend: (() => void) | null;
	/** Fired when the UA BEGINS CAPTURING AUDIO — the one event that means "this recognizer has the
	 *  microphone", as distinct from `onend`, which a recognizer that was refused the device fires
	 *  too (#535). Optional here because a stub may not have it, and because a browser that never
	 *  fires it leaves the gate unable to condemn, which is the safe direction. */
	onaudiostart?: (() => void) | null;
	start(): void;
	stop(): void;
	/** Standard on the real API; optional here because a stub may not have it. See `stop()` below. */
	abort?(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface WindowWithSpeech {
	SpeechRecognition?: SpeechRecognitionCtor;
	webkitSpeechRecognition?: SpeechRecognitionCtor;
}

export interface SpeechGate {
	/** Begin listening (idempotent). */
	start(): void;
	/** Stop listening (idempotent). Keeps the instance for a later start(). */
	stop(): void;
	/** True once at least one real (non-noise) word was heard since the last reset. */
	heardSpeech(): boolean;
	/** True once the recognizer has produced any event at all, EVER — including `onend`, which a
	 *  recognizer refused the microphone still fires. So this answers "has this engine ever run",
	 *  not "is it hearing now", and no verdict may use it (#535). Diagnostic only. */
	isAlive(): boolean;
	/**
	 * Does this gate have the microphone FOR THE CURRENT TURN?
	 *
	 * The question `planTurnClose` was asking `isAlive` and getting the wrong answer to. Set by
	 * `onaudiostart` (the UA reports capture has begun) or by any result arriving; cleared by
	 * `reset()` at every turn boundary and by any non-benign recognizer error — `audio-capture`,
	 * the code the two background recognizers produce fighting over one device, and the one on ten
	 * `client:voice-gate` rows the morning #535 was filed.
	 *
	 * False is the SAFE value: a gate that is not hearing abstains, and an abstaining gate cannot
	 * destroy a turn. A browser that never fires `onaudiostart` therefore loses the veto and keeps
	 * everything else.
	 */
	isHearing(): boolean;
	/** Did any transcript at all arrive this turn, accepted or not? Diagnostic only — it is what
	 *  distinguishes "the gate had no device" from "the gate had words and `acceptSpeech` or the
	 *  noise filter declined them", which #535 could otherwise only settle by watching the screen. */
	sawWords(): boolean;
	/** Clear the PER-TURN facts — heard, hearing, saw-words and any buffered interim (call at the
	 *  start of each turn). `isAlive` is session-lifetime and deliberately survives. */
	reset(): void;
}

export interface SpeechGateOptions {
	lang?: string;
	/**
	 * Live text as the user speaks — the always-visible dictation.
	 *
	 * TWO arguments, because two consumers want two different things and conflating them is a
	 * regression either way (#458):
	 *  - `text` is the whole UTTERANCE so far ({@link reduceHeard}), which is what the bubble
	 *    shows and what `heard` is stamped from. Before #458 it was the phrase, so a pause erased
	 *    everything said before it.
	 *  - `phrase` is just what changed in THIS event — the recogniser's own unit. It is what a
	 *    command scanner must see: a single-word command only fires when it IS the whole utterance
	 *    ({@link phraseMatchesTranscript}), so handing an accumulator to the matcher would make
	 *    "run the tests" + "mute" unmatchable and delete mute-during-capture (#228, ADR 0001 M1).
	 */
	onInterim: (text: string, phrase: string) => void;
	/** Fired the first time real words are heard this turn (→ the turn is legit). */
	onSpeech?: () => void;
	/**
	 * Could the words arriving RIGHT NOW belong to the user? Default: yes.
	 *
	 * The heard-speech flag is what `speechVerdict` trusts to discard a silent clip, and it
	 * used to latch on ANY recognised words — including the agent's own TTS coming back through
	 * the speakers, and anything picked up while a reply was in flight. So the gate would vouch
	 * for a turn in which the user had not spoken at all, the clip was uploaded, and Whisper
	 * returned a term from its own vocabulary prompt (#332: two turns reading "Coder Lead", the
	 * agent's name, with the user disengaged and the mic still open).
	 *
	 * The caller already computes exactly this predicate for the live-transcript path
	 * (`shouldIgnoreResult` — echo tail plus paused plus muted). Passing it here is what makes
	 * the veto and the display agree about whose voice they are hearing.
	 */
	acceptSpeech?: () => boolean;
	/**
	 * The recognizer could not have the microphone (#425).
	 *
	 * `r.onerror` was an empty block. That silence had two costs: nobody could learn that a gate had
	 * died, and `planNoiseRejection` treats a dead gate as "cannot vouch for this turn", so a
	 * blocked gate quietly changes which marginal turns survive. Reported through a callback rather
	 * than by importing the client here, so this module stays a pure browser adapter and the test
	 * can observe the call without a network stub.
	 *
	 * Named `onDenied` and gated on `isMicPermissionDenied` until the #425 reopen, which is how the
	 * two background recognizers ended up asymmetric: the control listener reported `audio-capture`
	 * and the gate did not, so the one contention code produced by two recognizers fighting over one
	 * device — the code actually seen in production — was invisible from exactly the recognizer that
	 * competes with the recorder. Reporting is now {@link isReportableMicError} on both.
	 */
	onMicError?: (code: string, detail: MicErrorDetail) => void;
}

/** Is browser dictation available at all? (Used to decide whether to gate.) */
export function speechGateAvailable(): boolean {
	if (typeof window === "undefined") return false;
	const w = window as unknown as WindowWithSpeech;
	return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
}

/**
 * Create a speech gate, or null when SpeechRecognition isn't available. The gate runs
 * continuously (auto-restarts on end while active) so it never stops watching mid-turn.
 */
export function createSpeechGate(opts: SpeechGateOptions): SpeechGate | null {
	if (typeof window === "undefined") return null;
	const w = window as unknown as WindowWithSpeech;
	const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
	if (!SR) return null;

	let rec: SpeechRecognitionLike | null = null;
	let active = false;
	let heard = false;
	/** The utterance so far — accumulated across phrases AND across the gate's own restarts (#458). */
	let utterance: HeardState = EMPTY_HEARD;
	let alive = false;
	/** Per-TURN: the recognizer has the device right now. Cleared by `reset()` and by any device or
	 *  permission failure — the distinction `alive` cannot make (#535). */
	let hearing = false;
	/** Per-TURN: a transcript arrived, whatever was then done with it. Diagnostic (#535). */
	let sawWords = false;
	/** The browser refused this origin the microphone. Terminal until the user changes it (#425). */
	let denied = false;
	let restartFails = 0;
	/** The failure RUN over the device, and the code that ended the current session — the inputs
	 *  {@link planMicRestart} needs to decide between an instant re-arm and a backoff (#425).
	 *  It is cleared ONLY by proof of capture, never by an error code: the gate is stopped and
	 *  started at every turn boundary, so clearing it on `aborted` — the code our own `stop()`
	 *  raises — reset the counter at exactly the moment the contention happens. See
	 *  {@link MicFailureRun}. */
	let micRun: MicFailureRun = NO_MIC_FAILURES;
	let lastCode: string | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	/** This gate's identity in the shared device handoff (#425). */
	const owner = nextMicOwner("gate");
	/** Did a `start()` succeed with no `onend` since? Only then does `stop()` have a close for the
	 *  next consumer to wait on — otherwise every turn end would cost the control listener the
	 *  handoff timeout for a session that was never open. */
	let sessionOpen = false;

	const build = (): SpeechRecognitionLike => {
		const r = new SR();
		r.continuous = true;
		r.interimResults = true;
		r.lang = opts.lang || "en-US";
		r.onaudiostart = () => {
			// The UA has the microphone open for this session. THE per-turn liveness fact: it is the
			// only event that means the device was actually acquired, and it is exactly what a
			// recognizer dying on `audio-capture` never gets to fire (#535).
			alive = true;
			hearing = true;
			// The UA acquired the device — the strongest proof of capture there is, and the one
			// event that can honestly end a failure run (#425).
			micRun = NO_MIC_FAILURES;
		};
		r.onresult = (e: SpeechRecognitionEventLike) => {
			alive = true;
			// Audio reached the recognizer, so it demonstrably has the device — belt-and-braces for a
			// browser that does not implement `onaudiostart`.
			hearing = true;
			// Audio arrived → the failure run is over (the only proof of recovery on offer).
			micRun = NO_MIC_FAILURES;
			// The WHOLE session (from 0) and the DELTA (from resultIndex) in one pass. The session
			// halves are what {@link reduceHeard} folds — recomputed, never accumulated, so a phrase
			// re-delivered as final after arriving as interim cannot be counted twice. The delta is
			// the recogniser's own unit and is what the phrase-scoped consumers below still see.
			let interim = "";
			let final = "";
			let deltaInterim = "";
			let deltaFinal = "";
			for (let i = 0; i < e.results.length; i++) {
				const t = e.results[i][0].transcript;
				const isFinal = e.results[i].isFinal;
				if (isFinal) final += ` ${t}`;
				else interim += ` ${t}`;
				if (i >= e.resultIndex) {
					if (isFinal) deltaFinal += t;
					else deltaInterim += t;
				}
			}
			utterance = reduceHeard(utterance, { type: "results", final, interim });
			const whole = heardText(utterance);
			// `(deltaFinal || deltaInterim)` — NOT `deltaFinal + deltaInterim`. This value reaches
			// the command matcher, where a single-word command must BE the whole transcript, so
			// appending the next phrase's opening syllable to a finalised "mute" would stop it
			// firing. The display half gets both, from `whole`, which is where the flicker #458
			// also reports actually lived.
			const phrase = (deltaFinal || deltaInterim).trim();
			// Words existed, whatever the two filters below then decide about them (#535).
			if (phrase) sawWords = true;
			if (whole) opts.onInterim(whole, phrase);
			// Real words (not a bare filler/punctuation) from someone who is not the agent → the
			// turn is legitimate. `acceptSpeech` is the ONLY thing standing between the agent's own
			// voice and a gate that vouches for a turn the user never took (#332). Judged on the
			// DELTA, as it always has been: the accumulated utterance would re-ask the question
			// about words already ruled on, under a guard whose answer has since changed.
			if (!heard && opts.acceptSpeech?.() !== false && !isNoiseTranscript(deltaFinal || deltaInterim)) {
				heard = true;
				opts.onSpeech?.();
			}
		};
		r.onerror = (e: { error: string }) => {
			// "no-speech"/"aborted" are normal for a gate — the onend restart handles it. A
			// PERMISSION verdict is not: it will not resolve by trying again, and re-arming into it
			// is what makes Chrome re-prompt on every restart (#425). Anything in between —
			// `audio-capture`, the recorder and this gate reaching for one device at a turn
			// boundary — is neither: it is reported and retried, with a backoff so the retry is not
			// itself a mic-activation storm.
			const code = e?.error;
			lastCode = code ?? null;
			if (!isBenignRecognizerEnd(code)) {
				// #535 criterion 4: the gate stops claiming to hear. `audio-capture` and the permission
				// codes all mean the same thing about this session — it does not have the device — and
				// until now the gate said nothing about itself either way, so a recognizer that never
				// got one audio frame went on vetoing turns. `no-speech` and `aborted` are excluded
				// deliberately: `no-speech` is the recognizer reporting FROM an open microphone that
				// nobody spoke, which is the evidence the veto is actually made of.
				hearing = false;
				micRun = noteMicFailure(micRun, Date.now());
			}
			if (planMicRestart({ code, consecutiveFailures: micRun.fails }).terminal) denied = true;
			if (isReportableMicError(code)) opts.onMicError?.(code, micErrorDetail(micRun, Date.now()));
		};
		r.onend = () => {
			// The device is genuinely free NOW — not when `stop()` was called, which is the whole of
			// the handoff race (#425): `stop()` returns immediately and the close lands here.
			sessionOpen = false;
			micHandoff.released(owner);
			// "It started and ended" — and NOTHING MORE. A recognizer that was refused the microphone
			// ends too, which is why this line may not touch `hearing`: reading it as liveness is the
			// whole of #535. `alive` keeps its honest, session-lifetime meaning and no verdict reads it.
			alive = true;
			// A restart resets `results`, so whatever this session heard has to be banked BEFORE it
			// is gone (#458). Done here rather than in `start()` because only this handler knows a
			// session ended at all — which is why the accumulator has to live in the gate and not
			// at the `onInterim` call site.
			utterance = reduceHeard(utterance, { type: "sessionEnd" });
			// `denied` is checked with `active` because a restart here cannot succeed and each
			// attempt costs the user another prompt.
			if (!active || denied) return;
			const plan = planMicRestart({ code: lastCode, consecutiveFailures: micRun.fails });
			lastCode = null;
			// Keep watching: restart unless it's failing in a tight loop (mic blocked). A failing
			// cycle waits — the no-delay version re-acquired the device as fast as Chrome would
			// cycle it, against a recorder that was in the middle of releasing it.
			const go = () => {
				if (!active || denied) return;
				// …and it waits for anyone else's close to finish, which the delay above cannot do:
				// a backoff is a guess about how long a release takes, the handoff is the fact.
				micHandoff.whenFree(owner, () => {
					if (!active || denied) return;
					try {
						r.start();
						sessionOpen = true;
						restartFails = 0;
					} catch {
						restartFails++;
						if (restartFails <= 3) setTimeout(() => { if (active) { try { r.start(); sessionOpen = true; } catch { /* give up quietly */ } } }, 250);
					}
				});
			};
			if (plan.delayMs <= 0) return go();
			if (retryTimer) clearTimeout(retryTimer);
			retryTimer = setTimeout(() => { retryTimer = null; go(); }, plan.delayMs);
		};
		return r;
	};

	return {
		start() {
			if (active || denied) return;
			active = true;
			if (!rec) rec = build();
			// The turn-start half of the handoff: `startAudioMonitor` runs one tick after
			// `startListening` told the control listener to stop, and that listener has not let go
			// of the device yet (#425). Synchronous when nobody is mid-close, which is the norm.
			micHandoff.whenFree(owner, () => {
				if (!active || denied || !rec) return;
				try {
					rec.start();
					sessionOpen = true;
				} catch {
					// Chrome throws if start() races a prior end — a fresh instance recovers.
					rec = build();
					try { rec.start(); sessionOpen = true; } catch { /* unavailable right now; onend won't fire */ }
				}
			});
		},
		stop() {
			active = false;
			// A queued start belongs to the turn that has just ended. Running it would reopen a
			// microphone the caller has closed — the #291 class of leak, via the new door.
			micHandoff.cancel(owner);
			// A pending backoff retry must not reopen the mic after the turn it belonged to ended.
			if (retryTimer) {
				clearTimeout(retryTimer);
				retryTimer = null;
			}
			// Claim the device as CLOSING before asking it to close, so the control listener the
			// reconcile effect is about to start waits for `onend` instead of racing it.
			if (sessionOpen) micHandoff.releasing(owner);
			if (rec) {
				try {
					rec.stop();
				} catch {
					// The gate is a SECOND live recognizer running beside the Whisper recorder, so a
					// swallowed stop leaves the mic open exactly the way #291 did — and here nothing
					// downstream would notice, because `active = false` only suppresses the restart
					// that a failed stop never triggers. `abort()` ends capture immediately.
					try { rec.abort?.(); } catch { /* nothing left to try */ }
				}
			}
		},
		heardSpeech() {
			return heard;
		},
		isAlive() {
			return alive;
		},
		isHearing() {
			return hearing;
		},
		sawWords() {
			return sawWords;
		},
		reset() {
			heard = false;
			// Per-turn, both of them, and for the same reason `heard` is: a fact about the last turn
			// answering a question about this one is what let a gate deaf since 08:51 condemn a turn
			// spoken at 08:57 (#535).
			hearing = false;
			sawWords = false;
			// The one place an utterance is forgotten, and the caller already calls this exactly
			// once per turn (`startAudioMonitor`) — which is what keeps text from bleeding across
			// turns now that it survives a restart.
			utterance = reduceHeard(utterance, { type: "reset" });
		},
	};
}
