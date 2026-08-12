/**
 * Serialised microphone HANDOFF between the consumers that share one input device (#425).
 *
 * PAGS runs three consumers over one microphone — the Whisper recorder (`getUserMedia` +
 * `MediaRecorder`), the dictation gate (Web Speech), and the always-on control listener (Web
 * Speech). Which of them may hold the device is already decided, correctly, and by design:
 *
 *  - the gate and the recorder run TOGETHER for the length of a Whisper turn (the gate is what
 *    puts live words on screen while the recorder buffers audio — that is the feature, and
 *    #332/#458/#535 are all bug reports about words it heard, so coexistence demonstrably works);
 *  - the control listener runs only while the main mic is idle (`shouldRunControlListener`), so it
 *    and the other two are mutually exclusive.
 *
 * What is NOT decided is the moment of exchange. `stop()` on a `SpeechRecognition` — and
 * `MediaRecorder.stop()` on the recorder — release the device ASYNCHRONOUSLY: the close completes
 * at `onend` / `onstop`, some milliseconds later. Every handoff in `use-voice.ts` starts the next
 * consumer in the same tick as it stops the previous one:
 *
 *   turn start  `ctrlStt.stop()` → `sttRef.start()` → `startAudioMonitor()` → `gate.start()`
 *   turn end    `gate.stop()` + `sttRef.stop()` → the reconcile effect → `ctrlStt.start()`
 *
 * So each boundary opens a window in which two consumers hold the device — one on its way out, one
 * on its way in. `audio-capture` ("the audio did not arrive") is the code a browser produces for
 * exactly that, it is the code on every production row for both background recognizers, and the
 * rows cluster in hands-free bursts, which is where turn boundaries are.
 *
 * This module is the missing ordering rule, and only that rule: **a consumer waits for an in-flight
 * close to finish before it opens the device.** It does not decide who may listen, it does not stop
 * two consumers running at once, and it therefore cannot delete the gate/recorder coexistence the
 * live-dictation feature is made of. An owner that merely HOLDS the device blocks nobody; only an
 * owner that is CLOSING does, and only until it has closed.
 *
 * ## The bound is the point (ADR 0001 M1)
 *
 * The control listener is the only listener running while the agent speaks or thinks, so a wait
 * here is a gap in mute-by-voice. Every wait is therefore capped by {@link MIC_HANDOFF_TIMEOUT_MS}
 * and the waiter runs REGARDLESS when it expires — a consumer whose `onend` never arrives forfeits
 * its claim on the device rather than holding the control channel shut. There is no path through
 * this module on which a queued start is dropped.
 */

/** How long a waiter will wait for someone else's close before opening the device anyway.
 *
 *  A `SpeechRecognition` close and a `MediaRecorder` stop both complete in a few tens of
 *  milliseconds, so this is generous for the case it exists to serialise. It is also the hard
 *  ceiling on how long mute-by-voice can be unreachable because of a handoff, which is the number
 *  that has to stay small: ADR 0001 M1 tolerates the exchange, not a dead zone. */
export const MIC_HANDOFF_TIMEOUT_MS = 300;

export interface MicHandoff {
	/** This owner has asked its recognizer/recorder to close. The device is not free until the
	 *  matching {@link released}. Idempotent. */
	releasing(owner: string): void;
	/** That close has completed — `onend` for a recognizer, the tracks actually stopped for the
	 *  recorder. Releases any waiter. Safe to call for an owner that was never `releasing`. */
	released(owner: string): void;
	/**
	 * Open the device as soon as nobody ELSE is mid-close: synchronously when the coast is clear,
	 * which is the overwhelmingly common case and must stay free of latency.
	 *
	 * One waiter per owner — a second call replaces the first, because the owner only ever wants
	 * its most recent intention honoured.
	 */
	whenFree(owner: string, start: () => void): void;
	/** Forget a queued {@link whenFree} — the owner was stopped before it ever got the device, and
	 *  starting it now would reopen a microphone the caller has already closed (#291). */
	cancel(owner: string): void;
	/** Owners whose close is still in flight. Diagnostics and tests only. */
	closing(): string[];
	/** Drop all state. Tests only: the handoff is process-wide by nature, so a test that leaves an
	 *  un-ended recognizer behind would otherwise make the next one wait on it. */
	reset(): void;
}

export function createMicHandoff(timeoutMs: number = MIC_HANDOFF_TIMEOUT_MS): MicHandoff {
	/** Owner → the timer that will forcibly consider it closed. */
	const closingNow = new Map<string, ReturnType<typeof setTimeout>>();
	const waiting = new Map<string, () => void>();

	const flush = () => {
		if (waiting.size === 0) return;
		const pending = [...waiting.entries()];
		waiting.clear();
		// Run them all: a waiter is a `start()` the caller has already committed to, and the
		// alternative to running it is a microphone that never opens.
		for (const [, start] of pending) start();
	};

	const clearOwner = (owner: string) => {
		const t = closingNow.get(owner);
		if (t) clearTimeout(t);
		closingNow.delete(owner);
	};

	return {
		releasing(owner) {
			clearOwner(owner);
			// Self-expiring. A close whose completion event never arrives — a recognizer wedged by
			// the same device failure this ticket is about — must not block the device forever;
			// after the timeout it is presumed closed and the next consumer proceeds.
			closingNow.set(
				owner,
				setTimeout(() => {
					closingNow.delete(owner);
					if (closingNow.size === 0) flush();
				}, timeoutMs),
			);
		},
		released(owner) {
			if (!closingNow.has(owner)) return;
			clearOwner(owner);
			if (closingNow.size === 0) flush();
		},
		whenFree(owner, start) {
			// Only SOMEONE ELSE's close blocks. An owner restarting its own recognizer is not
			// contending with anything, and making it wait on itself would deadlock the gate's
			// stop-then-start-in-the-same-turn path.
			const blockers = [...closingNow.keys()].filter((o) => o !== owner);
			if (blockers.length === 0) return start();
			waiting.set(owner, start);
		},
		cancel(owner) {
			waiting.delete(owner);
		},
		closing() {
			return [...closingNow.keys()];
		},
		reset() {
			for (const t of closingNow.values()) clearTimeout(t);
			closingNow.clear();
			waiting.clear();
		},
	};
}

/**
 * The one handoff every consumer on the page shares.
 *
 * It has to be module-level: the whole point is that the gate, the control listener and the
 * recorder are separate objects owned by different parts of `use-voice.ts` that must nevertheless
 * agree about one device. Passing it through would put the rule in the file that already carries
 * the sequencing bug, and that file is at its size ratchet.
 */
export const micHandoff: MicHandoff = createMicHandoff();

/** Distinct owner ids without the caller having to invent one. */
let seq = 0;
export function nextMicOwner(kind: string): string {
	seq += 1;
	return `${kind}:${seq}`;
}
