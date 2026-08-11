/**
 * Audible cues + the iOS/Safari speech unlock — the browser-audio side effects the voice
 * hook fires, with none of its state.
 *
 * These were module-level functions inside `use-voice.ts`: they close over nothing from the
 * hook, take primitives, and touch only WebAudio / SpeechSynthesis. That makes them the one
 * part of that file with a genuinely narrow seam, so they live here instead of in front of
 * the orchestration a reader is actually trying to follow.
 *
 * All of them swallow their own errors. A cue is feedback, never a step in a turn — a locked
 * tab or an unsupported engine must degrade to "no sound", never to a thrown exception that
 * aborts the mic open or the send that was about to happen.
 */

/**
 * The "mic is live again" cue (#152). Unmuting by VOICE has no visual gesture behind it —
 * the user is not looking at the screen, which is the whole point of hands-free — so a
 * confirmation they can HEAR is the only signal that the command landed. Synthesised with
 * WebAudio rather than an asset so it ships with the SDK and needs no network fetch.
 *
 * Deliberately short and quiet: it fires immediately before the mic opens, and anything
 * longer would be captured as the start of the user's own turn.
 */
export function playStartCue(): void {
	try {
		const Ctx = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
			?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!Ctx) return;
		const ctx = new Ctx();
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.frequency.value = 880;
		gain.gain.setValueAtTime(0.0001, ctx.currentTime);
		gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
		gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
		osc.connect(gain).connect(ctx.destination);
		osc.start();
		osc.stop(ctx.currentTime + 0.13);
		osc.onended = () => { try { void ctx.close(); } catch { /* already closed */ } };
	} catch { /* no audio context (locked tab / unsupported) — the visual pill still updates */ }
}

/**
 * Unlock browser Text-to-Speech synchronously inside a user gesture. iOS/Safari
 * won't speak an utterance that's queued LATER (e.g. an async agent reply) unless
 * SpeechSynthesis was first invoked during a real tap — this is the "replied in text
 * but not voice" cause. Speaking an empty utterance on the toggle primes it.
 */
export function unlockSpeechSynthesis(): void {
	try {
		if (typeof window !== "undefined" && window.speechSynthesis) {
			window.speechSynthesis.resume();
			// A volume-0 space (not an empty string): some engines ignore an empty
			// utterance, so it never counts as the gesture-initiated first speak that
			// iOS requires before a LATER async reply is allowed to speak.
			const u = new SpeechSynthesisUtterance(" ");
			u.volume = 0;
			window.speechSynthesis.speak(u);
		}
	} catch {
		// Ignorable, and the ONLY correct response (#291): this is a best-effort prime, and the
		// utterance it silences is a volume-0 space. If the browser refuses it, the later real
		// `speak()` still runs and reports its own failure through `voice-tts` — so surfacing
		// anything here would be a second, earlier, less accurate report of the same problem.
	}
}

// Short tones via Web Audio — no external files.
// Module-level singleton, as it was in use-voice.ts: every view's hook shares one context,
// because browsers cap how many a page may open (~6) and hands-free reopens the mic on
// every turn. Resumed on use — see getAudioCtx's caller in toggleConvo, which resumes it
// inside the tap so the first chime isn't swallowed by an autoplay-suspended context.
let _audioCtx: AudioContext | null = null;
export function getAudioCtx(): AudioContext {
	if (!_audioCtx) _audioCtx = new AudioContext();
	return _audioCtx;
}

function playTone(freq: number, dur: number, volume = 0.15) {
	try {
		const ctx = getAudioCtx();
		if (ctx.state === "suspended") ctx.resume();
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = "sine";
		osc.frequency.value = freq;
		gain.gain.value = volume;
		gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
		osc.connect(gain).connect(ctx.destination);
		osc.start();
		osc.stop(ctx.currentTime + dur);
	} catch {
		// Ignorable: a chime is a courtesy, not a channel. Every state it decorates is also on
		// screen in the status pill, so a browser that will not open an oscillator loses a sound
		// and no information — and this runs on every mic open, so reporting it would flood the
		// durable log with one row per turn for a condition that changes nothing (#291).
	}
}

/** Rising two-tone: "your turn" — the mic just opened. */
export function playListeningChime(): void {
	playTone(600, 0.08);
	setTimeout(() => playTone(900, 0.1), 100);
}

/** Falling two-tone: "got it" — the turn was sent, the agent is thinking. */
export function playThinkingChime(): void {
	playTone(500, 0.12);
	setTimeout(() => playTone(350, 0.15), 120);
}
