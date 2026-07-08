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
	start(): void;
	stop(): void;
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
	/** True once the recognizer has actually produced any event (proof the engine runs).
	 *  The caller only trusts a "no speech → discard" verdict from a gate that's alive, so
	 *  a browser that exposes SpeechRecognition but never runs it can't black-hole speech. */
	isAlive(): boolean;
	/** Clear the heard-speech flag + any buffered interim (call at the start of each turn). */
	reset(): void;
}

export interface SpeechGateOptions {
	lang?: string;
	/** Live partial text as the user speaks — the always-visible dictation. */
	onInterim: (text: string) => void;
	/** Fired the first time real words are heard this turn (→ the turn is legit). */
	onSpeech?: () => void;
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
	let alive = false;
	let restartFails = 0;

	const build = (): SpeechRecognitionLike => {
		const r = new SR();
		r.continuous = true;
		r.interimResults = true;
		r.lang = opts.lang || "en-US";
		r.onresult = (e: SpeechRecognitionEventLike) => {
			alive = true;
			let interim = "";
			let final = "";
			for (let i = e.resultIndex; i < e.results.length; i++) {
				const t = e.results[i][0].transcript;
				if (e.results[i].isFinal) final += t;
				else interim += t;
			}
			const shown = (final || interim).trim();
			if (shown) opts.onInterim(shown);
			// Real words (not a bare filler/punctuation) → the turn is legitimate.
			if (!heard && !isNoiseTranscript(final || interim)) {
				heard = true;
				opts.onSpeech?.();
			}
		};
		r.onerror = () => {
			/* "no-speech"/"aborted" are normal for a gate — the onend restart handles it. */
		};
		r.onend = () => {
			alive = true; // it started and ended → the engine is running
			if (!active) return;
			// Keep watching: restart unless it's failing in a tight loop (mic blocked).
			try {
				r.start();
				restartFails = 0;
			} catch {
				restartFails++;
				if (restartFails <= 3) setTimeout(() => { if (active) { try { r.start(); } catch { /* give up quietly */ } } }, 250);
			}
		};
		return r;
	};

	return {
		start() {
			if (active) return;
			active = true;
			if (!rec) rec = build();
			try {
				rec.start();
			} catch {
				// Chrome throws if start() races a prior end — a fresh instance recovers.
				rec = build();
				try { rec.start(); } catch { /* unavailable right now; onend won't fire */ }
			}
		},
		stop() {
			active = false;
			if (rec) {
				try { rec.stop(); } catch { /* already stopped */ }
			}
		},
		heardSpeech() {
			return heard;
		},
		isAlive() {
			return alive;
		},
		reset() {
			heard = false;
		},
	};
}
