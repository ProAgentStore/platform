/**
 * ADR 0001 — "mute is available at every moment of a voice session" — made checkable (#388).
 *
 * The ADR exists because the constraint is NOT discoverable from the code that would break it.
 * #386 is a real defect (the always-on control listener had no echo guard) and its first proposed
 * fix was one line: drop control results while `isEchoing`. That line reuses an already-tested
 * helper, matches three neighbouring call sites, and deletes mute-during-TTS — the entire
 * capability #153 built that listener for. Nothing in the types, the tests, or the file being
 * edited would have objected. This file is the thing that objects.
 *
 * ── What these tests are, and what they deliberately are not
 *
 * They are NOT a pin on today's matching rules. A test that asserts `commandStateFor("partial",
 * { echoing: true }).judgeable === false` passes any refactor that keeps that number and quietly
 * removes the capability, and it FAILS the next legitimate echo-guard change — which is worse than
 * useless, because the ADR's own list of permitted techniques (content comparison, a higher bar
 * during TTS) all change exactly that. `convo.test.ts` already holds those unit-level assertions
 * for #386; they belong there, next to the rule they describe.
 *
 * What is asserted here is REACHABILITY: in every phase the ADR enumerates, some transcript a user
 * can actually produce dispatches `mute` (or `unmute`, muted) along the path the hook really takes.
 * A guard is legal iff mute survives it. That is the ADR's distinction between "raise the bar" and
 * "close the door", stated so a machine can apply it to a guard nobody has written yet.
 *
 * Three kinds of assertion, because the invariant lives in three places:
 *   1. BEHAVIOURAL, over the real decision path (`commandStateFor` → `matchVoiceCommand`) driven
 *      by the real echo predicate (`isEchoing`), in every phase.
 *   2. A GUARD TABLE that classifies candidate answers to #386 — including the rejected one — by
 *      whether mute survives them, so the rule outlives the current implementation.
 *   3. STRUCTURAL, over `use-voice.ts`, because the rejected one-liner would land in the hook and
 *      no pure test can see it. The hook is untestable here (no jsdom, no renderer in this repo),
 *      and "somewhere in the file" is not the claim — each guard slices out the one callback it is
 *      about. This is the shape `security-invariants.test.ts` and `turn.test.ts` already use.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readAdr } from "../../../../scripts/lib/adr.mjs";
import { commandStateFor, matchVoiceCommand, shouldRunControlListener, type TranscriptKind, type VoiceCommand } from "./convo.js";
import { isEchoing } from "./machine.js";

/** Shared with the TOUCH half of this same ADR — see `scripts/lib/adr.mjs` for why the parse is
 *  not duplicated per test file. */
const adr = readAdr(1);
const ADR = adr.text;
const USE_VOICE = readFileSync(new URL("./use-voice.ts", import.meta.url), "utf-8");

/**
 * The rules, read FROM the ADR rather than copied out of it. A fifth rule added to the document
 * therefore fails here until it is covered — an omission that would otherwise be silent, which is
 * the failure mode of every "keep the doc and the tests in sync" convention that is only a habit.
 */
const COVERED: Record<string, string> = {
	M1: "a deliberate utterance reaches mute in every phase",
	M2: "mute closes the mic AND cancels the speech it interrupts",
	M3: "no condition may reduce to 'not while the agent is speaking'",
	M4: "unmute is symmetric, on the one listener that runs while muted",
};

/**
 * One moment in a live voice session, named as the ADR names it. `guard` is fed to the REAL echo
 * predicate rather than reduced to a boolean here, so a change to `ECHO_GUARD_MS` — or to what
 * counts as echoing at all — is exercised by these tests instead of being mocked past.
 */
interface Phase {
	name: string;
	/** Is the MAIN recorder capturing a user turn? This is what decides which listener is live. */
	mainRecording: boolean;
	guard: { ttsSpeaking: boolean; speakEndedAt: number };
}

const NOW = 1_000_000;
const SILENT = { ttsSpeaking: false, speakEndedAt: 0 };
const TALKING = { ttsSpeaking: true, speakEndedAt: 0 };
/** Playback just ended — still inside the ~0.8s tail where the room may hand the mic the agent. */
const TAIL = { ttsSpeaking: false, speakEndedAt: NOW - 200 };

const PHASES: Phase[] = [
	// The one phase where the control listener yields: the main pipeline is capturing and checks
	// control words itself (browser dictation on its interims, the speech gate under Whisper).
	{ name: "listening (the user's turn is being captured)", mainRecording: true, guard: SILENT },
	{ name: "transcribing (the clip is uploading, mic closed)", mainRecording: false, guard: SILENT },
	{ name: "processing (the agent is thinking)", mainRecording: false, guard: SILENT },
	{ name: "speaking (the agent is talking)", mainRecording: false, guard: TALKING },
	{ name: "speaking (the echo tail, just after playback)", mainRecording: false, guard: TAIL },
];

/** Every transcript kind, because a phase is allowed to accept only some of them (M3 permits
 *  raising the bar); what it may not do is accept none. */
const KINDS: TranscriptKind[] = ["partial", "final"];

/**
 * The control path as the hook takes it: the recognizer hands over a transcript and which KIND it
 * is, the hook derives the matching rules from that plus the state it was captured in, and the
 * matcher answers. Both halves are the shipped functions — this mirrors the composition, not the
 * decision, and the structural guard below is what keeps the mirror honest.
 */
function dispatch(text: string, kind: TranscriptKind, p: Phase, muted: boolean): VoiceCommand | null {
	return matchVoiceCommand(text, undefined, "en", commandStateFor(kind, { muted, echoing: isEchoing(p.guard, NOW) }));
}

/** Is `command` reachable at all in this phase — by ANY transcript kind, for ANY of the words a
 *  user would deliberately say to reach it? */
function reachable(command: "mute" | "unmute", p: Phase, muted: boolean, said: string[]): boolean {
	return said.some((text) => KINDS.some((kind) => dispatch(text, kind, p, muted) === command));
}

/** What a user actually says. Both a bare word and the doubled emphatic the ADR uses as its
 *  worked example, because the doubled form is what survives a raised bar. */
const SAYS_MUTE = ["mute", "mute mute"];
const SAYS_UNMUTE = ["unmute", "unmute mic"];

/** The one callback in `use-voice.ts` this rule is about. Sliced rather than grepped: a regex over
 *  a 1,700-line file cannot say WHICH function it matched in, and every claim below is about one. */
function callbackBody(name: string, endsAt: string): string {
	const start = USE_VOICE.indexOf(`const ${name} = useCallback(`);
	const end = USE_VOICE.indexOf(endsAt, start + 1);
	expect(start, `use-voice.ts no longer declares ${name} — this guard is now looking at nothing`).toBeGreaterThan(-1);
	expect(end, `cannot find the end of ${name} (${endsAt}) — fix the slice before trusting the assertions`).toBeGreaterThan(start);
	return USE_VOICE.slice(start, end);
}

describe("ADR 0001 — mute is available at every moment (#388)", () => {
	it("covers every rule the ADR states — adding a fifth is a visible test change, not a silent gap", () => {
		// `readAdr` throws rather than returning [] when nothing parses, so "no rules" can never be
		// mistaken here for "every rule covered".
		expect(adr.rules, "the ADR states a rule this file does not hold, or holds one the ADR no longer states").toEqual(Object.keys(COVERED));
	});
});

describe("M1 — reachable at every moment", () => {
	it("dispatches mute in every phase the ADR names", () => {
		for (const p of PHASES) {
			const via = shouldRunControlListener({ engaged: true, mainRecording: p.mainRecording }) ? "the always-on control listener" : "the main transcription path";
			expect(reachable("mute", p, false, SAYS_MUTE), `${p.name}: nothing a user can say reaches mute via ${via}. ADR 0001 M1 — no phase may be a dead zone.`).toBe(true);
		}
	});

	/**
	 * WHICH listener carries each phase, asserted so the two halves cannot both quietly become the
	 * other's job. #153 is exactly that bug: control words were checked only inside the main
	 * transcription paths, which run only while the mic is capturing a user turn, so mute did
	 * nothing during the three phases where a user most wants it.
	 */
	it("hands every mic-idle phase to the control listener, and yields only where the main path is already matching", () => {
		for (const p of PHASES) {
			expect(shouldRunControlListener({ engaged: true, mainRecording: p.mainRecording }), `${p.name}: the wrong listener is live`).toBe(!p.mainRecording);
		}
		// A voice session must be engaged for any of this to hold — text chat has no invariant to
		// break, and this is the boundary the rule stops at rather than an exception to it.
		expect(shouldRunControlListener({ engaged: false, mainRecording: false })).toBe(false);
	});
});

describe("M2 — immediate and bidirectional", () => {
	/**
	 * Mute silences BOTH directions at once. The half that is easy to lose is the second: a mute
	 * that closes the microphone and lets the agent keep talking is the failure a user reaches for
	 * mute to escape, and it looks complete from the mic's side.
	 */
	it("closes the microphone AND cancels the speech it is interrupting", () => {
		const body = callbackBody("muteFromCommand", "const muteFromCommandRef");
		expect(body, "mute no longer closes the microphone (ADR 0001 M2)").toMatch(/sttRef\.current\?\.stop\(\)/);
		expect(body, "mute no longer cancels in-flight speech — muting an agent that keeps talking is not mute (ADR 0001 M2)").toMatch(/ttsRef\.current\?\.cancel\(\)/);
	});

	/**
	 * M1's two channels have to arrive at M2's one implementation. This is the assertion that was
	 * missing, and #388 found the defect it describes: `toggleMute` — the ON-SCREEN control, and
	 * the ONLY channel on a browser with no Web Speech API — restated the mute branch instead of
	 * delegating, one line short of the version above, and the line it was missing was
	 * `tts.cancel()`. Pressing Mute mid-sentence closed the mic and left the agent talking, while
	 * the button, the pill and the state all read "Muted".
	 *
	 * Asserted as delegation rather than by re-checking the two effects here, because a second copy
	 * that happens to be correct today is the same defect waiting: the fix is that there is one
	 * implementation, not that both copies currently agree.
	 */
	it("routes the on-screen control into that same implementation, both directions", () => {
		const body = callbackBody("toggleMute", "// The three modes are derived");
		expect(body, "the on-screen mute no longer delegates to muteFromCommand — a local copy will not cancel in-flight speech (ADR 0001 M1 + M2)").toMatch(/muteFromCommandRef\.current\(\)/);
		expect(body, "the on-screen unmute no longer delegates to unmuteFromCommand — a local copy will not reopen the mic (ADR 0001 M4)").toMatch(/unmuteFromCommandRef\.current\(\)/);
		expect(body, "the on-screen control sets mute state itself instead of delegating — that is how the two copies drifted (ADR 0001 M2)").not.toMatch(/setMuted\(|mutedRef\.current =/);
	});
});

describe("M3 — no condition may reduce to 'not while the agent is speaking'", () => {
	const SPEAKING = PHASES.filter((p) => isEchoing(p.guard, NOW));

	it("lands a deliberate mute while the agent talks, and inside its echo tail", () => {
		expect(SPEAKING.length, "no phase in the table is echoing — this rule is being asserted against nothing").toBe(2);
		for (const p of SPEAKING) {
			expect(reachable("mute", p, false, SAYS_MUTE), `${p.name}: mute is unreachable inside the echo window. This is #386's first draft (ADR 0001 M3).`).toBe(true);
		}
	});

	/**
	 * The rule, applied to guards nobody has written yet.
	 *
	 * `drop` is a candidate answer to #386, written the way a reviewer would describe it in a PR,
	 * and applied IN FRONT of the real decision path — so a row is legal exactly when a deliberate
	 * mute still gets through both it and whatever narrowing the shipped code already applies.
	 *
	 * This is why the file does not simply assert today's behaviour. The ADR lists content
	 * comparison and a raised bar as PERMITTED, and #386 still has to be fixable: a test that
	 * pinned "no partials during TTS" would forbid the better fix. A test that asks "does mute
	 * survive?" permits every technique the ADR permits and rejects the one it forbids, including
	 * the forms of it nobody has thought of yet.
	 */
	it("classifies a candidate echo guard by whether mute survives it", () => {
		const guards: { name: string; legal: boolean; drop: (t: { text: string; kind: TranscriptKind }) => boolean }[] = [
			// The near-miss, verbatim. One line, an existing tested helper, three neighbouring call
			// sites doing the same thing — and #153's whole capability gone.
			{ name: "#386's first draft — drop control results while isEchoing", legal: false, drop: () => true },
			// The same rule wearing a different helper's name. It reads as consistency with the main
			// result path, which is precisely how it would pass review a second time.
			{ name: "the same rule as shouldIgnoreResult, for consistency with the main path", legal: false, drop: () => true },
			// What actually shipped (2532f00), and what must stay legal.
			{ name: "shipped — judge no PARTIAL inside the echo window, finals whole-utterance only", legal: true, drop: (t) => t.kind === "partial" },
			// ADR 0001's preferred technique: ask whose voice it is instead of when it arrived.
			{ name: "ADR 0001 (1) — reject a transcript matching the utterance being spoken", legal: true, drop: (t) => "stop me if this is wrong".includes(t.text) },
			// The narrowest form of "a higher bar, not a closed door".
			{ name: "ADR 0001 (3) — never a bare single word on a partial while TTS plays", legal: true, drop: (t) => t.kind === "partial" && !t.text.includes(" ") },
		];
		for (const p of SPEAKING) {
			for (const g of guards) {
				const survives = SAYS_MUTE.some((text) => KINDS.some((kind) => !g.drop({ text, kind }) && dispatch(text, kind, p, false) === "mute"));
				expect(survives, `${g.name} — during "${p.name}", mute ${g.legal ? "must survive this guard" : "does not survive this guard, and the ADR forbids it (M3)"}`).toBe(g.legal);
			}
		}
	});

	/**
	 * The half no pure test can see. The rejected fix is an early return in the hook, above the
	 * matcher — the pure functions would never know it happened. So: inside the control-path
	 * callback, the echo signal may be handed TO the matcher as an argument, and may not be used as
	 * a reason to return without asking it.
	 */
	it("passes the echo signal to the matcher and never uses it to drop the result", () => {
		const body = callbackBody("handleControlResult", "const handleControlResultRef");
		const uses = body
			.split("\n")
			.filter((l) => !l.trim().startsWith("//"))
			.filter((l) => /\b(isEchoing|shouldIgnoreResult|classifyResult)\(/.test(l));
		expect(uses.length, "the control path no longer consults the echo guard at all — #386 is back").toBeGreaterThan(0);
		for (const line of uses) {
			expect(line.trim(), "the control path uses the echo guard for something other than telling the matcher about it. ADR 0001 M3: raise the bar, do not close the door.").toMatch(/echoing:\s*isEchoing\(/);
		}
		// …and it still dispatches both directions, so "no early return" cannot be satisfied by a
		// path that reaches the matcher and then does nothing with the answer.
		expect(body, "the control path no longer dispatches mute (ADR 0001 M1)").toMatch(/cmd === "mute"/);
		expect(body, "the control path no longer dispatches unmute (ADR 0001 M4)").toMatch(/cmd === "unmute"/);
	});

	it("keeps ADR 0001 one hop from the place it would be broken", () => {
		expect(callbackBody("handleControlResult", "const handleControlResultRef"), "the pointer to the ADR is what makes the constraint discoverable from the code being changed (#388)").toContain(
			"docs/adr/0001-mute-is-always-available.md",
		);
	});
});

describe("M4 — unmute is symmetric", () => {
	/** While muted the main recorder is closed by construction, so the muted mirror of "listening"
	 *  does not exist. That is M4's premise — the control listener is the ONLY listener running —
	 *  not a phase this skips. */
	const MUTED_PHASES = PHASES.filter((p) => !p.mainRecording);

	it("dispatches unmute in every phase mute can be entered from", () => {
		expect(MUTED_PHASES.length, "every phase now captures a user turn — the muted mirror has vanished").toBeGreaterThan(0);
		for (const p of MUTED_PHASES) {
			expect(shouldRunControlListener({ engaged: true, mainRecording: false }), `${p.name}: nothing is listening while muted`).toBe(true);
			expect(reachable("unmute", p, true, SAYS_UNMUTE), `${p.name}: muted can be entered but not left by the same channel. That is M1 with the sign flipped (ADR 0001 M4).`).toBe(true);
		}
	});

	it("reopens the microphone rather than only clearing the flag", () => {
		// The stale-ref trap this callback exists to hold: `startListening` bails on
		// `mutedRef.current`, which React refreshes only on the next render, so setting state alone
		// leaves the mic shut and looks exactly like the bug unmute exists to fix.
		const body = callbackBody("unmuteFromCommand", "const unmuteFromCommandRef");
		expect(body, "unmute no longer clears the ref synchronously (ADR 0001 M4)").toMatch(/mutedRef\.current = false/);
		expect(body, "unmute no longer reopens the mic (ADR 0001 M4)").toMatch(/startListening\(\)/);
	});
});

/**
 * The gap, asserted as a gap.
 *
 * The control listener is built on the browser Web Speech API. Where the constructor is absent
 * `ensureControlStt` returns null, no control listener runs at all, and mute-by-voice during
 * TTS/thinking does not exist — the invariant there rests entirely on the on-screen control. The
 * ADR records this deliberately; a test that quietly passed would let the repo believe the
 * invariant is closed everywhere, which is a worse state than a named hole.
 */
describe("the known hole — a browser with no Web Speech API (ADR 0001, Consequences)", () => {
	it("is recorded in the ADR, in the place a reader would look for it", () => {
		expect(ADR, "the ADR no longer names the hole — either it was closed (update this file) or it was quietly dropped").toMatch(/Known hole/);
		expect(ADR, "the ADR no longer names the code path that creates the hole").toMatch(/ensureControlStt/);
	});

	it("still exists: the control listener has no fallback, so only the on-screen mute satisfies M1 there", () => {
		const body = callbackBody("ensureControlStt", "const handleResult = useCallback(");
		expect(body, "the Web Speech gate moved — re-check whether the hole is closed or merely hidden").toMatch(/webkitSpeechRecognition\)\) return null/);
		expect(body, "the control listener is browser-Web-Speech only; a second engine here would close the hole").toMatch(/new VoiceStt\("browser"/);
		// If a fallback ever lands, THIS test is what has to change — deliberately, in the same
		// commit that updates the ADR's Consequences section. That is the point of writing the gap
		// down as an assertion rather than as a sentence nobody re-reads.
	});
});
