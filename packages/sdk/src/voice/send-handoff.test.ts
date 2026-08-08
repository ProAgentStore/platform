/**
 * The bubble→message handoff is ATOMIC (#455).
 *
 * A hands-free turn is on screen twice in a row and never once in between: first as the pending
 * dictation bubble, then as the sent message. `finalize` performs that swap, and whether the user
 * sees a gap between the two is decided entirely by WHEN React commits — not by anything in the
 * words, the transport, or the model.
 *
 * The defect was a `flushSync` that cleared the bubble and painted, synchronously, before the
 * message existed. That is a guaranteed empty frame on EVERY hands-free send. The fix is to clear
 * the bubble AFTER `emitSend`, where React batches it with `onSend`'s `setMessages` into one commit.
 *
 * ── Why two halves
 *
 * The precondition is invisible: the fixed code is four ordinary statements, and the property that
 * makes them correct — "no task boundary between these two lines" — is not expressed by any of
 * them. Someone adding an `await`, a `setTimeout`, or a second `flushSync` in the middle reverts
 * the bug while the diff still reads as a no-op. So:
 *
 *   1. A MODEL of React's commit semantics, replaying the three orderings (the shipped bug, the
 *      fix, and the fix with an `await` in it) and grading the frames they paint. This states what
 *      "atomic" MEANS without needing a browser, a microphone, or a renderer.
 *   2. STRUCTURAL assertions over `use-voice.ts`, because the hook cannot be mounted here (no jsdom
 *      and no renderer in this repo — the same constraint `mute-invariant.test.ts` works around,
 *      and the same technique: slice out the one callback the claim is about, never "somewhere in
 *      the file"). This is what fails when the flush, or the await, comes back.
 *
 * What is NOT claimed: a real frame count in a real browser. That needs a live microphone and a
 * hands-free turn. The model asserts the semantics; the structural half asserts the code has the
 * shape those semantics require.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const USE_VOICE = readFileSync(new URL("./use-voice.ts", import.meta.url), "utf-8");

// ── 1. The commit model ──────────────────────────────────────────────────────

/** What is on screen at one painted commit. */
interface Frame {
	bubble: string | null;
	messages: string[];
}

/**
 * React 18's two commit rules, and nothing else:
 *
 *   - state set during a task is BATCHED — one commit at the end of the task, whatever the call
 *     site (an event, a timer, an STT callback: automatic batching covers them all);
 *   - `flushSync` commits and PAINTS right there, synchronously, including whatever was already
 *     pending.
 *
 * Everything the bug turns on is in those two sentences, so the model is those two sentences.
 */
class CommitModel {
	private bubble: string | null = null;
	private messages: string[] = [];
	private dirty = false;
	readonly frames: Frame[] = [];

	setBubble(text: string | null) {
		this.bubble = text;
		this.dirty = true;
	}
	addMessage(text: string) {
		this.messages.push(text);
		this.dirty = true;
	}
	/** A React state update that is not part of the handoff (the mic/paused half of #284). */
	touch() {
		this.dirty = true;
	}
	flushSync(fn: () => void) {
		fn();
		this.paint();
	}
	/** The task ends: React flushes whatever was batched. */
	endTask() {
		if (this.dirty) this.paint();
	}
	private paint() {
		this.frames.push({ bubble: this.bubble, messages: [...this.messages] });
		this.dirty = false;
	}
}

/**
 * The property, stated once: at every painted commit the turn's words are visible in EXACTLY one
 * place. Zero is the reported gap (#455). Two is the artifact the "render the message first, then
 * clear" alternative produces — a duplicate flash rather than an empty one, which is a different
 * defect, not an improvement. Both are non-atomic, and one predicate catches both.
 */
function handoffIsAtomic(frames: Frame[], text: string): boolean {
	return frames.every((f) => (f.bubble !== null ? 1 : 0) + (f.messages.includes(text) ? 1 : 0) === 1);
}

const SPOKEN = "run the tests";

/** The shipped bug: `clearVoiceText()` inside the flushSync, `emitSend` after it. */
function orderingShipped(): Frame[] {
	const m = new CommitModel();
	m.setBubble(SPOKEN);
	m.endTask(); // the bubble is on screen; the turn ends and finalize runs
	m.flushSync(() => {
		m.setBubble(null); // ← clearVoiceText
		m.touch(); // stopAudioMonitor / setMicOn(false)
	});
	m.addMessage(SPOKEN); // ← emitSend → onSend → setMessages
	m.endTask();
	return m.frames;
}

/** The fix: the flush keeps the mic half; the clear batches with the message. */
function orderingFixed(): Frame[] {
	const m = new CommitModel();
	m.setBubble(SPOKEN);
	m.endTask();
	m.flushSync(() => {
		m.touch(); // stopAudioMonitor / setPaused / setMicOn(false) — #284, still immediate
	});
	m.addMessage(SPOKEN); // ← emitSend
	m.setBubble(null); // ← clearVoiceText, batched with it
	m.endTask();
	return m.frames;
}

/** The fix with a task boundary between the two lines — an `await`, a timer, a second flushSync. */
function orderingFixedWithAwait(): Frame[] {
	const m = new CommitModel();
	m.setBubble(SPOKEN);
	m.endTask();
	m.flushSync(() => m.touch());
	m.addMessage(SPOKEN);
	m.endTask(); // ← the await: React commits here, with BOTH on screen
	m.setBubble(null);
	m.endTask();
	return m.frames;
}

describe("the hands-free handoff, as React commits it", () => {
	it("the shipped ordering paints a frame with neither the bubble nor the message", () => {
		const frames = orderingShipped();
		expect(frames).toContainEqual({ bubble: null, messages: [] });
		expect(handoffIsAtomic(frames, SPOKEN)).toBe(false);
	});

	it("clearing AFTER emitSend swaps the two in one commit", () => {
		const frames = orderingFixed();
		expect(handoffIsAtomic(frames, SPOKEN)).toBe(true);
		expect(frames).not.toContainEqual({ bubble: null, messages: [] });
		// The bubble is still up on the forced paint — that flush is about the mic, not the words.
		expect(frames[frames.length - 2]).toEqual({ bubble: SPOKEN, messages: [] });
		expect(frames[frames.length - 1]).toEqual({ bubble: null, messages: [SPOKEN] });
	});

	it("a task boundary between emitSend and the clear breaks it again — differently, still broken", () => {
		const frames = orderingFixedWithAwait();
		expect(handoffIsAtomic(frames, SPOKEN)).toBe(false);
		// Not the empty frame this time: the words are on screen TWICE. Named so the failure message
		// says which regression happened.
		expect(frames).toContainEqual({ bubble: SPOKEN, messages: [SPOKEN] });
	});
});

// ── 2. The code has the shape the model requires ─────────────────────────────

/** Everything from `flushSync(` to its matching `)`, so a claim about the callback is about the
 *  callback and not about the next twenty lines of the file. */
function callbackOf(src: string, from: number): string {
	const open = src.indexOf("(", from);
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "(") depth++;
		else if (src[i] === ")" && --depth === 0) return src.slice(open, i + 1);
	}
	throw new Error("unbalanced flushSync(");
}

function slice(from: string, to: string): string {
	const a = USE_VOICE.indexOf(from);
	expect(a, `anchor not found: ${from}`).toBeGreaterThan(-1);
	const b = USE_VOICE.indexOf(to, a);
	expect(b, `anchor not found: ${to}`).toBeGreaterThan(a);
	return USE_VOICE.slice(a, b);
}

/** `finalize` — the whole of it, from its definition to the ref that lets the max-duration timer
 *  end a turn through the same code. */
const FINALIZE = slice("const finalize = (msg: string) => {", "finalizeRef.current = finalize");
/** The SEND branch: the last flushSync before the emit, through the end of finalize. */
const SEND_BLOCK = FINALIZE.slice(FINALIZE.lastIndexOf("flushSync(", FINALIZE.indexOf("emitSendRef.current(")));
const SEND_FLUSH = callbackOf(SEND_BLOCK, SEND_BLOCK.indexOf("flushSync("));
/** Between the emit and the clear — where a regression would be inserted. */
const BETWEEN = SEND_BLOCK.slice(SEND_BLOCK.indexOf("emitSendRef.current("), SEND_BLOCK.indexOf("clearVoiceText()"));

describe("finalize's send path", () => {
	it("does not clear the pending bubble inside the forced paint", () => {
		expect(SEND_FLUSH).not.toContain("clearVoiceText");
	});

	it("clears it after emitSend, so React batches the clear with setMessages", () => {
		const emit = SEND_BLOCK.indexOf("emitSendRef.current(");
		const clear = SEND_BLOCK.indexOf("clearVoiceText()");
		expect(emit).toBeGreaterThan(-1);
		expect(clear).toBeGreaterThan(emit);
	});

	/**
	 * The precondition, made enforceable. Anything here that ends the synchronous task — an
	 * `await`, a timer, a microtask, a second forced paint — puts a commit between the message and
	 * the clear and the handoff stops being atomic. The model above says which artifact you get.
	 */
	it.each(["await ", "flushSync(", "setTimeout(", "queueMicrotask(", ".then("])("has no %s between the emit and the clear", (boundary) => {
		expect(BETWEEN).not.toContain(boundary);
	});

	it("still commits the mic and paused state immediately (#284)", () => {
		expect(SEND_FLUSH).toContain("setMicOn(false)");
		expect(SEND_FLUSH).toContain("setPaused(true)");
		expect(SEND_FLUSH).toContain("stopAudioMonitor()");
	});

	it("keeps the chime out of the render-flush callback", () => {
		expect(SEND_FLUSH).not.toContain("playThinkingChime");
		expect(SEND_BLOCK).toContain("playThinkingChime()");
	});

	/** A turn `planSend` refuses (noise, wrong language) has no message to hand the bubble over to.
	 *  It is MARKED, not erased — #377's contract — and the clear is conditional on a real send. */
	it("marks the bubble when nothing was sent, instead of blanking it", () => {
		expect(SEND_BLOCK).toMatch(/if \(outcome\.sent\) clearVoiceText\(\);/);
		expect(SEND_BLOCK).toMatch(/dictate\(\{ type: "failed", note: outcome\.note/);
	});
});

describe("emitSend reports whether it sent", () => {
	const EMIT = slice("const emitSend = (text: string)", "const emitSendRef = useRef(emitSend)");

	it("is typed as a verdict, not void", () => {
		expect(USE_VOICE).toContain('const emitSend = (text: string): { sent: true } | { sent: false; note: string } =>');
	});

	it("returns the drop with a note, and the send without one", () => {
		expect(EMIT).toMatch(/return \{ sent: false, note:/);
		expect(EMIT).toContain("return { sent: true };");
		// One drop return and one send return — no path may fall out of the function reporting nothing.
		expect(EMIT.match(/\breturn \{/g)?.length).toBe(2);
	});
});

/**
 * `finalize` is shared by the Whisper path, the browser-dictation silence timer, the stop-word
 * early flush and the max-duration timer. The fix is applied once BECAUSE of that, so the sharing
 * is part of the claim: a fourth entry point that emitted its own send would bypass the handoff and
 * bring the empty frame back on one path only — the hardest kind of report to reproduce.
 */
describe("every hands-free entry point goes through the one handoff", () => {
	const HANDS_FREE = slice("if (convoOnRef.current) {", "// Push-to-talk: send immediately");

	it("defines finalize exactly once", () => {
		expect(USE_VOICE.match(/const finalize = /g)?.length).toBe(1);
	});

	it("emits the send from exactly one place in the hands-free path", () => {
		expect(HANDS_FREE.match(/emitSendRef\.current\(/g)?.length).toBe(1);
	});

	it("routes the Whisper transcript, the silence timer and the stop-word flush into it", () => {
		// Named by their arguments, which is what tells the three apart: the Whisper transcript, the
		// combined partial that tripped the stop-word, the accumulated finals, and the debounce.
		for (const call of ["finalize(t)", "finalize(combinedNow)", "finalize(pendingTextRef.current.trim())", "finalize(msg)"]) {
			expect(HANDS_FREE, `missing entry point: ${call}`).toContain(call);
		}
		// …and the max-duration timer, which reaches it through the ref rather than the closure.
		expect(USE_VOICE).toContain("finalizeRef.current = finalize");
	});
});

/**
 * #457 step 3 — the wiring that carries "a command already fired" from the gate to `finalize`.
 *
 * The DECISION is pure and tested in turn.test.ts (`planFinalizedTurn` with `firedDuringCapture`).
 * What cannot be tested there is that the fact ever arrives: three statements in three different
 * callbacks, none of which reads as load-bearing on its own. Drop any one and the pure test stays
 * green while "run the tests, mute" ships the word to the agent again — which is exactly how the
 * defect existed for so long behind a comment that claimed it did not.
 */
describe("the fired-command fact reaches finalize (#457 step 3)", () => {
	const GATE = slice("onInterim: (text, phrase) => {", "// Ignore the agent's own voice (echo tail)");

	it("records WHAT fired at the gate's own dispatch, where the knowledge is", () => {
		expect(GATE, "the gate fires mute without recording it — finalize will send the word too").toMatch(
			/cmd === "mute"\)\s*\{\s*firedCommandRef\.current = cmd;/,
		);
		expect(GATE).toMatch(/cmd === "unmute"\)\s*\{\s*firedCommandRef\.current = cmd;/);
	});

	it("hands it to the turn plan, which is the only thing that can act on it", () => {
		expect(FINALIZE, "finalize no longer tells planFinalizedTurn what fired").toMatch(/firedDuringCapture: firedCommandRef\.current/);
	});

	/**
	 * Per TURN, not per session. Without the reset the flag outlives the turn that set it and the
	 * NEXT utterance ending in "mute" is silently truncated — a stray word turned into a lost
	 * clause, which is the strictly worse direction (#457's own asymmetry argument).
	 */
	it("is cleared at the start of every turn, beside the gate's own reset", () => {
		const START = slice("const startAudioMonitor = useCallback(async () => {", "const biasPrompt = useCallback(");
		expect(START.indexOf("firedCommandRef.current = null"), "the fired flag is never cleared — it will leak into the next turn").toBeGreaterThan(-1);
		expect(START.indexOf("firedCommandRef.current = null")).toBeLessThan(START.indexOf("gateRef.current?.start()"));
	});
});
