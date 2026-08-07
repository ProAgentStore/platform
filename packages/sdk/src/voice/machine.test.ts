import { describe, expect, it } from "vitest";
import { ECHO_GUARD_MS, isEchoing, shouldIgnoreResult, canOpenMic, classifyResult, endOfTurnAction, derivePhase, isLateTurn, prepareConversationSwitch, resolveToggleAction, reduceDictation, dictationDiverged, dictationLoss, storedDictation, DICTATION_MAX, type Dictation } from "./machine.js";

const NOW = 1_000_000;

describe("isEchoing", () => {
	it("true while the agent is speaking", () => {
		expect(isEchoing({ ttsSpeaking: true, speakEndedAt: 0 }, NOW)).toBe(true);
	});
	it("true within the echo tail after speech ends, false after it", () => {
		expect(isEchoing({ ttsSpeaking: false, speakEndedAt: NOW - (ECHO_GUARD_MS - 1) }, NOW)).toBe(true);
		expect(isEchoing({ ttsSpeaking: false, speakEndedAt: NOW - ECHO_GUARD_MS }, NOW)).toBe(false);
		expect(isEchoing({ ttsSpeaking: false, speakEndedAt: NOW - 5000 }, NOW)).toBe(false);
	});
});

describe("shouldIgnoreResult", () => {
	const base = { ttsSpeaking: false, speakEndedAt: 0, paused: false, muted: false };
	it("ignores while echoing (self-transcription guard)", () => {
		expect(shouldIgnoreResult({ ...base, ttsSpeaking: true }, NOW)).toBe(true);
		expect(shouldIgnoreResult({ ...base, speakEndedAt: NOW - 100 }, NOW)).toBe(true);
	});
	it("ignores while paused (a turn is already in flight / teardown)", () => {
		expect(shouldIgnoreResult({ ...base, paused: true }, NOW)).toBe(true);
	});
	it("accepts a normal result (not echoing, not paused)", () => {
		expect(shouldIgnoreResult(base, NOW)).toBe(false);
	});
	it("muted alone does NOT swallow a result (that's handled by not opening the mic)", () => {
		expect(shouldIgnoreResult({ ...base, muted: true }, NOW)).toBe(false);
	});
});

describe("isLateTurn (#175 — capture before the pause is the user's own speech)", () => {
	it("capture that started BEFORE the pause is the user's turn", () => {
		expect(isLateTurn({ captureStartedAt: 1000, pausedAt: 2000 })).toBe(true);
	});
	it("capture that started DURING the pause is echo / abandoned", () => {
		expect(isLateTurn({ captureStartedAt: 2000, pausedAt: 1000 })).toBe(false);
		expect(isLateTurn({ captureStartedAt: 1000, pausedAt: 1000 })).toBe(false);
	});
	it("unknown timings are never recoverable (under-stamping stays safe)", () => {
		expect(isLateTurn({ captureStartedAt: 0, pausedAt: 2000 })).toBe(false);
		expect(isLateTurn({ captureStartedAt: 1000, pausedAt: 0 })).toBe(false);
		expect(isLateTurn({ captureStartedAt: 0, pausedAt: 0 })).toBe(false);
	});
});

describe("classifyResult (#175)", () => {
	const base = { ttsSpeaking: false, speakEndedAt: 0, paused: false, muted: false, captureStartedAt: 0, pausedAt: 0 };
	it("a normal result is accepted (sent as a turn)", () => {
		expect(classifyResult({ ...base, captureStartedAt: NOW - 3000 }, NOW)).toBe("accept");
	});
	it("THE BUG: dictation interrupted by an agent reply is recovered, not dropped", () => {
		// User starts speaking at T-5s; the agent's reply lands at T-1s → pause + TTS. The clip
		// still transcribes, and used to hit `paused` and die one line before it would be sent.
		expect(classifyResult(
			{ ...base, paused: true, ttsSpeaking: true, captureStartedAt: NOW - 5000, pausedAt: NOW - 1000 },
			NOW,
		)).toBe("recover");
	});
	it("still recovers once the agent finished speaking (transcript lands in the echo tail)", () => {
		expect(classifyResult(
			{ ...base, paused: false, speakEndedAt: NOW - 100, captureStartedAt: NOW - 5000, pausedAt: NOW - 4000 },
			NOW,
		)).toBe("recover");
	});
	it("the agent NEVER transcribes its own TTS — that capture starts during the pause", () => {
		expect(classifyResult(
			{ ...base, ttsSpeaking: true, paused: true, captureStartedAt: NOW - 500, pausedAt: NOW - 2000 },
			NOW,
		)).toBe("ignore");
		expect(classifyResult(
			{ ...base, speakEndedAt: NOW - 200, captureStartedAt: NOW - 100, pausedAt: NOW - 2000 },
			NOW,
		)).toBe("ignore");
	});
	it("a turn the user abandoned (capture opened after the pause) is still dropped", () => {
		expect(classifyResult(
			{ ...base, paused: true, captureStartedAt: NOW - 1000, pausedAt: NOW - 4000 },
			NOW,
		)).toBe("ignore");
	});
	it("no timing information at all behaves exactly like the old guard", () => {
		expect(classifyResult({ ...base, paused: true }, NOW)).toBe("ignore");
		expect(classifyResult({ ...base, ttsSpeaking: true }, NOW)).toBe("ignore");
		expect(classifyResult(base, NOW)).toBe("accept");
	});
});

describe("canOpenMic", () => {
	it("open only when neither paused nor muted", () => {
		expect(canOpenMic({ paused: false, muted: false })).toBe(true);
		expect(canOpenMic({ paused: true, muted: false })).toBe(false);
		expect(canOpenMic({ paused: false, muted: true })).toBe(false);
		expect(canOpenMic({ paused: true, muted: true })).toBe(false);
	});
});

describe("endOfTurnAction (dictation gate)", () => {
	it("no gate (iOS / gate off) → always transcribe", () => {
		expect(endOfTurnAction(null)).toBe("transcribe");
		expect(endOfTurnAction(undefined)).toBe("transcribe");
	});
	it("alive gate that heard nothing → discard (silence/keyboard/noise)", () => {
		expect(endOfTurnAction({ isAlive: true, heardSpeech: false })).toBe("discard");
	});
	it("alive gate that heard real words → transcribe", () => {
		expect(endOfTurnAction({ isAlive: true, heardSpeech: true })).toBe("transcribe");
	});
	it("a NOT-alive gate can never veto real speech → transcribe", () => {
		// The safety valve: a stalled/dead recognizer must not black-hole your voice.
		expect(endOfTurnAction({ isAlive: false, heardSpeech: false })).toBe("transcribe");
	});
});

describe("derivePhase", () => {
	const base = { mode: "handsfree" as const, thinking: false, speaking: false, transcribing: false, micOn: false, muted: false };
	it("thinking wins over everything (incl. text mode)", () => {
		for (const mode of ["text", "ptt", "handsfree"] as const) {
			expect(derivePhase({ ...base, mode, thinking: true, speaking: true, transcribing: true, micOn: true })).toBe("processing");
		}
	});
	it("speaking beats transcribing/listening", () => {
		expect(derivePhase({ ...base, speaking: true, transcribing: true, micOn: true })).toBe("speaking");
	});
	it("text mode with no work is idle", () => {
		expect(derivePhase({ ...base, mode: "text" })).toBe("idle");
	});
	it("transcribing shows after speech, before the reply", () => {
		expect(derivePhase({ ...base, transcribing: true, micOn: true })).toBe("transcribing");
	});
	it("hands-free muted reads muted, not a false listening", () => {
		expect(derivePhase({ ...base, muted: true })).toBe("muted");
	});
	it("mic hot → listening; mic off → idle", () => {
		expect(derivePhase({ ...base, micOn: true })).toBe("listening");
		expect(derivePhase({ ...base, micOn: false })).toBe("idle");
	});

	// THE #284 BUG: `starting` happens BEFORE convoOn flips, so the mode is still "text". Checked
	// after the text-mode return the phase would be unreachable for its whole lifetime — i.e. the
	// press would still have no visible effect, which is the entire report.
	it("starting is visible while the mode is still text (the whole point of the state)", () => {
		expect(derivePhase({ ...base, mode: "text", starting: true })).toBe("starting");
	});
	it("starting outranks an idle/listening mic but never the agent's own work", () => {
		expect(derivePhase({ ...base, starting: true })).toBe("starting");
		expect(derivePhase({ ...base, starting: true, thinking: true })).toBe("processing");
		expect(derivePhase({ ...base, starting: true, speaking: true })).toBe("speaking");
	});
	it("omitting starting keeps every existing phase byte-for-byte (optional field)", () => {
		expect(derivePhase({ ...base, micOn: true })).toBe(derivePhase({ ...base, micOn: true, starting: false }));
	});
});

describe("resolveToggleAction (#284)", () => {
	it("a normal tap starts, and a tap while live stops", () => {
		expect(resolveToggleAction({ starting: false, active: false })).toBe("start");
		expect(resolveToggleAction({ starting: false, active: true })).toBe("stop");
	});
	// THE BUG: opening the mic takes two awaits with no feedback, so an impatient second tap ran
	// a SECOND getUserMedia — leaking the first stream and racing two recognizers onto one device.
	it("a second tap while starting is ignored, not a second getUserMedia", () => {
		expect(resolveToggleAction({ starting: true, active: false })).toBe("ignore");
	});
	// Cancelling on the second tap would make an impatient tap indistinguishable from a
	// deliberate one — the session the user asked for is already on its way.
	it("ignore wins over stop: an impatient tap must not cancel the session being opened", () => {
		expect(resolveToggleAction({ starting: true, active: true })).toBe("ignore");
	});
});

describe("reduceDictation (#281 — the words must survive the status change)", () => {
	const AT = 5_000;
	const live: Dictation = { text: "verify the application is built", status: "dictating", startedAt: AT, heard: "" };

	// THE BUG, exactly: end-of-turn used to assign "Transcribing…" OVER the words, so for the
	// whole upload round trip the user's speech existed nowhere on screen.
	it("end-of-turn changes the STATUS and keeps the text", () => {
		const next = reduceDictation(live, { type: "endOfTurn", at: AT + 100 });
		expect(next).toMatchObject({ text: "verify the application is built", status: "transcribing" });
	});
	it("end-of-turn snapshots what was heard live, for the divergence check", () => {
		expect(reduceDictation(live, { type: "endOfTurn", at: AT + 100 })?.heard).toBe("verify the application is built");
	});
	// iOS has no speech gate, so nothing is heard live — the bubble must still appear and say
	// what is happening rather than leaving the reported gap.
	it("end-of-turn with nothing heard live still opens a transcribing bubble", () => {
		expect(reduceDictation(null, { type: "endOfTurn", at: AT })).toMatchObject({ text: "", status: "transcribing" });
	});
	// Recognizers emit empty partials routinely between phrases; treating one as "nothing was
	// said" is how a live bubble flickers empty.
	it("an empty partial never blanks a live bubble", () => {
		expect(reduceDictation(live, { type: "speech", text: "   ", at: AT + 10 })).toBe(live);
	});
	// gpt-4o-transcribe streams partials AFTER end-of-turn. Those are the transcription landing,
	// not new speech — flipping back to "dictating" would claim the mic is hot while it is closed.
	it("streaming partials after end-of-turn update the text but hold the transcribing status", () => {
		const t = reduceDictation(live, { type: "endOfTurn", at: AT + 100 });
		const next = reduceDictation(t, { type: "speech", text: "verify the application is built on the platform", at: AT + 200 });
		expect(next).toMatchObject({ text: "verify the application is built on the platform", status: "transcribing" });
	});
	it("the utterance start time is stable across the turn (usable as a render key)", () => {
		const a = reduceDictation(null, { type: "speech", text: "hello there", at: AT });
		const b = reduceDictation(a, { type: "speech", text: "hello there friend", at: AT + 400 });
		expect(b?.startedAt).toBe(AT);
	});
	// "A failed transcription leaves the bubble with its partials and the recording, not an
	// empty gap" — the ticket's verification, and the reason failure keeps the text.
	it("failure keeps the words and records why", () => {
		expect(reduceDictation(live, { type: "failed", note: "Whisper 400", at: AT + 500 }))
			.toMatchObject({ text: "verify the application is built", status: "failed", note: "Whisper 400" });
	});
	it("a failed turn is over — new speech starts a fresh one instead of reviving it", () => {
		const failed = reduceDictation(live, { type: "failed", note: "boom", at: AT + 1 })!;
		const next = reduceDictation(failed, { type: "speech", text: "new sentence", at: AT + 900 });
		expect(next).toMatchObject({ text: "new sentence", status: "dictating", startedAt: AT + 900 });
		expect(next?.note).toBeUndefined(); // the previous turn's failure must not stick to the new one
	});
	// The single invariant this reducer exists to hold: only an explicit clear removes words.
	it("ONLY clear removes the utterance", () => {
		expect(reduceDictation(live, { type: "clear" })).toBeNull();
		for (const ev of [{ type: "endOfTurn" as const, at: AT }, { type: "failed" as const, note: "x", at: AT }]) {
			expect(reduceDictation(live, ev)?.text).toBe(live.text);
		}
	});
});

describe("dictationDiverged (#281 — a lost tail should be observable, not a vague feeling)", () => {
	// The reported symptom: the agent answered "I don't have context on what 'this model' refers
	// to" because the tail of the sentence never made it into the final transcript.
	it("flags a final that dropped most of what was heard", () => {
		expect(dictationDiverged("verify the application is built on the platform for the MCP", "for this model")).toBe(true);
	});
	// The live gate is browser Web Speech and the final is Whisper — they disagree about wording
	// constantly. Flagging that would make the signal worthless.
	it("ordinary engine disagreement about WORDING is not a divergence", () => {
		expect(dictationDiverged("fix the bugs in the parser today", "fixed the bars in the parser today")).toBe(false);
	});
	it("an empty final after a real sentence is the worst loss, and is flagged", () => {
		expect(dictationDiverged("please summarise the deployment status", "")).toBe(true);
	});
	it("nothing heard live (iOS, no gate) can never accuse the final", () => {
		expect(dictationDiverged("", "a perfectly good transcript")).toBe(false);
	});
});

// The volume test above is switched off below four words, which left the two turns in #371 that
// came back as pure nonsense as the only two the guard could not comment on. Short utterances are
// the most likely to be mistranscribed and had no check at all.
describe("dictationDiverged (#371 — a short utterance is judged by OVERLAP, not volume)", () => {
	it("flags the reported turns: nothing in the final is anything that was heard", () => {
		expect(dictationDiverged("Do it", "Duet")).toBe(true);
		expect(dictationDiverged("Send", "context:")).toBe(true);
	});
	it("a spelling disagreement between the two engines is NOT a divergence", () => {
		expect(dictationDiverged("colour", "color")).toBe(false);
		expect(dictationDiverged("Heartfull", "Heartful")).toBe(false);
		expect(dictationDiverged("go ahead", "Go ahead.")).toBe(false);
	});
	it("one word in common is enough — the engines heard the same utterance", () => {
		expect(dictationDiverged("do it now", "do that now")).toBe(false);
	});
	it("an empty final after a short utterance is still the worst loss", () => {
		expect(dictationDiverged("coder lead", "")).toBe(true);
	});
	it("short words are not fuzzy-matched into each other", () => {
		// `go`/`no` and `it`/`is` are DIFFERENT words; a one-edit allowance at this length would
		// make the guard agree with a transcript that inverted the instruction.
		expect(dictationDiverged("go", "no")).toBe(true);
	});
});

describe("prepareConversationSwitch (#277/#279 — one guard for changing who you talk to)", () => {
	const dict = (over: Partial<Dictation> = {}): Dictation => ({ text: "", status: "dictating", startedAt: NOW, heard: "", ...over });

	// The whole reason hands-free breaks today: switching agent has to keep the mic ON the other
	// side, or "next" would drop the user into a silent screen they then have to touch.
	it("carries the voice mode across so hands-free stays hands-free", () => {
		expect(prepareConversationSwitch({ mode: "handsfree", ttsSpeaking: false, dictation: null }).carryMode).toBe("handsfree");
		expect(prepareConversationSwitch({ mode: "ptt", ttsSpeaking: false, dictation: null }).carryMode).toBe("ptt");
	});

	// The mirror of that, and the privacy half of #278: a typist must not land in a live mic.
	it("carries nothing when the user was typing", () => {
		expect(prepareConversationSwitch({ mode: "text", ttsSpeaking: false, dictation: null }).carryMode).toBeNull();
	});

	// The agent you are leaving must not keep talking over the one you arrive at — the switch
	// has to be audible as a switch, which is what the spoken announcement is for.
	it("cuts the outgoing agent's speech, and only when it is speaking", () => {
		expect(prepareConversationSwitch({ mode: "handsfree", ttsSpeaking: true, dictation: null }).cancelSpeech).toBe(true);
		expect(prepareConversationSwitch({ mode: "handsfree", ttsSpeaking: false, dictation: null }).cancelSpeech).toBe(false);
	});

	// #175's loss class, in its new form: "next" heard by the control listener while a Whisper
	// clip of REAL words is mid-upload. Sending them is wrong (that thread is gone); dropping
	// them silently is the bug. They go back to the composer.
	it("recovers words that were spoken for the agent being left", () => {
		const p = prepareConversationSwitch({
			mode: "handsfree",
			ttsSpeaking: false,
			dictation: dict({ text: "run the deploy", status: "transcribing", heard: "run the deploy" }),
		});
		expect(p.recoverText).toBe("run the deploy");
		expect(p.clearDictation).toBe(true);
	});

	// The common case: the utterance WAS the command, so the caller has already cleared it and
	// there is nothing to hand back. Recovering "next" into the composer would be absurd.
	it("recovers nothing when the utterance was the command itself", () => {
		const p = prepareConversationSwitch({ mode: "handsfree", ttsSpeaking: false, dictation: null });
		expect(p.recoverText).toBe("");
		expect(p.clearDictation).toBe(false);
	});
});

describe("dictationLoss (#319 — how many words the final did not account for)", () => {
	it("counts the words heard live that the transcript never carried", () => {
		expect(dictationLoss("open the deploy log for the api worker", "open the deploy log")).toBe(4);
	});
	it("is zero when the transcript carries everything, whatever the punctuation or case", () => {
		expect(dictationLoss("open the Deploy log", "Open the deploy log!")).toBe(0);
	});
	// The two strings come from different engines, so ordering is not evidence — only absence is.
	it("does not count re-ordering as loss", () => {
		expect(dictationLoss("deploy the api worker", "worker api the deploy")).toBe(0);
	});
	// A word said twice and transcribed once IS one word missing; a set difference would miss it.
	it("counts repeats, because a multiset is the honest comparison", () => {
		expect(dictationLoss("no no no", "no")).toBe(2);
	});
	it("is zero when nothing was heard live", () => {
		expect(dictationLoss("", "a perfectly good transcript")).toBe(0);
	});
});

describe("storedDictation (#319 — what is worth keeping beside the transcript)", () => {
	it("keeps the live capture when it differs from the transcript", () => {
		expect(storedDictation("open the deploy log for the api worker", "open the deploy log")).toBe(
			"open the deploy log for the api worker",
		);
	});
	// The whole point of the rule: a bubble only sprouts a toggle where there is a second
	// reading to show. Nothing heard live = a typed turn, or iOS with no dictation gate.
	it("stores nothing when nothing was heard live", () => {
		expect(storedDictation("", "a perfectly good transcript")).toBeNull();
		expect(storedDictation("   ", "a perfectly good transcript")).toBeNull();
	});
	// Storing a second copy of the same sentence would be a duplicate record of one fact, and
	// a toggle that switches between two identical strings.
	it("stores nothing when the two engines agree, ignoring case and punctuation", () => {
		expect(storedDictation("Open the deploy log.", "open the deploy log")).toBeNull();
	});
	// Wording disagreement is exactly the case worth keeping — it is invisible otherwise.
	it("stores a mis-hearing even when no words were lost", () => {
		expect(storedDictation("fix the bugs in the parser", "fix the bars in the parser")).toBe("fix the bugs in the parser");
	});
	it("caps what it stores, so one runaway recognizer cannot bloat a message", () => {
		const long = "word ".repeat(2000);
		expect(storedDictation(long, "short")?.length).toBe(DICTATION_MAX);
	});
});
