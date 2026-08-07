import { describe, expect, it } from "vitest";
import { commandPhrases, decideRestart, matchVoiceCommand, resolveVoiceMode, resolveVoiceStatus, shouldRunControlListener, shouldScanGateTranscript, splitTrailingCommand, stripStopWord, transcriptLanguageMismatch } from "./convo.js";

describe("decideRestart", () => {
	it("reopens the mic (no bail) after a healthy-length turn and resets the counter", () => {
		const d = decideRestart(5000, 3); // 5s turn — not rapid
		expect(d.bail).toBe(false);
		expect(d.nextRapidEnds).toBe(0);
	});

	it("counts a rapid end without bailing yet", () => {
		const d = decideRestart(100, 0); // ended 100ms after start
		expect(d.bail).toBe(false);
		expect(d.nextRapidEnds).toBe(1);
	});

	it("bails after maxRapid consecutive rapid ends (freeze guard)", () => {
		// 1 → 2 → 3 → bail on the 4th
		let rapid = 0;
		let last = decideRestart(50, rapid);
		for (let i = 0; i < 2; i++) { rapid = last.nextRapidEnds; last = decideRestart(50, rapid); }
		expect(last.nextRapidEnds).toBe(3);
		const bailing = decideRestart(50, last.nextRapidEnds);
		expect(bailing.bail).toBe(true);
		expect(bailing.nextRapidEnds).toBe(0); // reset on bail
	});

	it("a healthy turn between rapids resets the streak so it never bails", () => {
		let d = decideRestart(50, 0);   // rapid → 1
		d = decideRestart(50, d.nextRapidEnds); // rapid → 2
		d = decideRestart(4000, d.nextRapidEnds); // healthy → reset
		expect(d.nextRapidEnds).toBe(0);
		expect(d.bail).toBe(false);
	});

	it("honours custom thresholds", () => {
		expect(decideRestart(50, 0, { maxRapid: 1 }).bail).toBe(true); // bail on first rapid
		expect(decideRestart(300, 5, { rapidMs: 200 }).nextRapidEnds).toBe(0); // 300ms not rapid under 200ms
	});
});

describe("matchVoiceCommand", () => {
	it("matches 'repeat' and its common phrasings", () => {
		for (const phrase of ["repeat", "Repeat", "repeat that", "repeat it", "say again", "say that again", "come again", "pardon", "what did you say", "Repeat, please."]) {
			expect(matchVoiceCommand(phrase)).toBe("repeat");
		}
	});

	it("ignores trailing punctuation and case", () => {
		expect(matchVoiceCommand("  REPEAT!  ")).toBe("repeat");
	});

	it("does NOT hijack a normal sentence that merely contains the word", () => {
		expect(matchVoiceCommand("repeat the booking for next week")).toBeNull();
		expect(matchVoiceCommand("can you say that flight is cheap")).toBeNull();
		expect(matchVoiceCommand("book a flight to Sydney")).toBeNull();
	});

	it("returns null for empty / unrelated input", () => {
		expect(matchVoiceCommand("")).toBeNull();
		expect(matchVoiceCommand("hello there")).toBeNull();
	});

	it("matches repeat phrasings in a language ONLY when it's the agent's set language", () => {
		const cases: Array<[string, string]> = [["再说一遍。", "zh"], ["もう一度。", "ja"], ["다시 말해줘", "ko"], ["¿Qué dijiste?", "es"], ["Répète.", "fr"], ["Wie bitte?", "de"], ["De novo!", "pt"]];
		for (const [phrase, lang] of cases) {
			expect(matchVoiceCommand(phrase, undefined, lang)).toBe("repeat");
			expect(matchVoiceCommand(phrase, undefined, "en-US")).toBeNull(); // wrong language ⇒ no match
		}
	});

	it("accepts a full BCP-47 tag (zh-CN, fr-FR)", () => {
		expect(matchVoiceCommand("再说一遍", undefined, "zh-CN")).toBe("repeat");
		expect(matchVoiceCommand("répète", undefined, "fr-FR")).toBe("repeat");
	});

	it("does NOT hijack a real sentence in another language", () => {
		expect(matchVoiceCommand("我想再说一遍这个故事给你听", undefined, "zh")).toBeNull();
		expect(matchVoiceCommand("repite conmigo la frase completa", undefined, "es")).toBeNull();
	});

	it("matches the built-in 'mute' phrasings (whole-utterance)", () => {
		for (const phrase of ["mute", "Mute.", "mute mic", "mute microphone", "stop listening"]) {
			expect(matchVoiceCommand(phrase)).toBe("mute");
		}
		expect(matchVoiceCommand("mute the notification about my flight")).toBeNull();
	});

	it("custom keywords REPLACE the defaults", () => {
		const words = { repeat: ["again"], mute: ["silence", "quiet please"] };
		expect(matchVoiceCommand("again", words)).toBe("repeat");
		expect(matchVoiceCommand("silence", words)).toBe("mute");
		expect(matchVoiceCommand("quiet please", words)).toBe("mute");
		// A default that isn't in the custom list no longer matches.
		expect(matchVoiceCommand("repeat", words)).toBeNull();
		expect(matchVoiceCommand("mute", words)).toBeNull();
	});

	it("a multi-word mute PHRASE ('mute mute') matches as a whole phrase, not its halves", () => {
		const words = { mute: ["mute mute"] };
		// The whole phrase → match.
		expect(matchVoiceCommand("mute mute", words)).toBe("mute");
		expect(matchVoiceCommand("Mute mute.", words)).toBe("mute"); // punctuation/case-insensitive
		// A multi-word phrase also fires when it appears as a contiguous whole-word run.
		expect(matchVoiceCommand("okay mute mute now", words)).toBe("mute");
		// Only HALF the phrase → must NOT match ("mute" alone is not "mute mute").
		expect(matchVoiceCommand("mute", words)).toBeNull();
		// A near-miss that isn't the contiguous phrase → no match.
		expect(matchVoiceCommand("mute the mute button", words)).toBeNull();
	});

	it("a single-word phrase still requires the WHOLE utterance (precision preserved)", () => {
		const words = { mute: ["hush"] };
		expect(matchVoiceCommand("hush", words)).toBe("mute");
		// Single word must not fire inside a sentence — otherwise it hijacks normal speech.
		expect(matchVoiceCommand("please hush the alerts", words)).toBeNull();
	});
});

describe("shouldRunControlListener (#153 — always-on control-word listener)", () => {
	it("runs when voice is engaged AND the main recorder is idle (speaking / thinking / muted)", () => {
		expect(shouldRunControlListener({ engaged: true, mainRecording: false })).toBe(true);
	});
	it("YIELDS while the main recorder is actively capturing (avoids two recognizers at once)", () => {
		expect(shouldRunControlListener({ engaged: true, mainRecording: true })).toBe(false);
	});
	it("never runs when voice isn't engaged (plain text mode)", () => {
		expect(shouldRunControlListener({ engaged: false, mainRecording: false })).toBe(false);
		expect(shouldRunControlListener({ engaged: false, mainRecording: true })).toBe(false);
	});
});

describe("stripStopWord", () => {
	it("is off (never ends) when no stop-words are configured", () => {
		expect(stripStopWord("do the thing copy")).toEqual({ ended: false, text: "do the thing copy" });
		expect(stripStopWord("do the thing copy", [])).toEqual({ ended: false, text: "do the thing copy" });
	});

	it("ends the turn and strips a trailing stop-word", () => {
		expect(stripStopWord("book the flight to sydney copy", ["copy"])).toEqual({ ended: true, text: "book the flight to sydney" });
		expect(stripStopWord("Do it, copy.", ["copy"])).toEqual({ ended: true, text: "Do it" });
	});

	it("treats a lone stop-word as end-of-turn with nothing to send", () => {
		expect(stripStopWord("copy", ["copy"])).toEqual({ ended: true, text: "" });
	});

	it("does NOT strip a stop-word that isn't at the very end", () => {
		expect(stripStopWord("copy this file to the server", ["copy"])).toEqual({ ended: false, text: "copy this file to the server" });
	});

	it("supports multi-word stop-words", () => {
		expect(stripStopWord("send the email over and out", ["over and out"])).toEqual({ ended: true, text: "send the email" });
	});

	// ── #334: the same spoken phrase must not depend on how Whisper punctuated it ──────────
	//
	// The owner has "stop stop" configured. Whisper renders a repeated word as a hyphenated
	// compound SOMETIMES — a formatting choice, not a transcription difference — so the turn
	// ended on one rendering and was sent to the agent as a chat message on the next. That is
	// the reported "seems like it works now, weird"; it will not reproduce reliably by hand,
	// which is why the three renderings are pinned here.
	it("ends the turn on every rendering of the SAME utterance (the 'Stop-stop.' report)", () => {
		for (const rendering of ["Stop-stop.", "Stop stop.", "Stop, stop.", "stop—stop", "STOP-STOP!"]) {
			expect(stripStopWord(rendering, ["stop stop"])).toEqual({ ended: true, text: "" });
		}
	});

	it("strips a hyphenated stop-word off the END without eating the word before it", () => {
		// The old slice dropped N whitespace tokens for an N-word stop-word. "stop-stop" is ONE
		// token and TWO normalised words, so that arithmetic ate "tests," and sent "run the".
		expect(stripStopWord("run the tests, stop-stop", ["stop stop"])).toEqual({ ended: true, text: "run the tests" });
		expect(stripStopWord("run the tests, stop stop", ["stop stop"])).toEqual({ ended: true, text: "run the tests" });
	});

	it("a hyphenated rendering of a single-word stop-word still only matches at the end", () => {
		expect(stripStopWord("Do it — copy.", ["copy"])).toEqual({ ended: true, text: "Do it" });
		expect(stripStopWord("copy this file to the server", ["copy"])).toEqual({ ended: false, text: "copy this file to the server" });
	});
});

describe("resolveVoiceMode", () => {
	it("hands-free wins whenever continuous conversation is on", () => {
		expect(resolveVoiceMode(true, true)).toBe("handsfree");
		expect(resolveVoiceMode(true, false)).toBe("handsfree");
	});

	it("replies-aloud without continuous listen is push-to-talk", () => {
		expect(resolveVoiceMode(false, true)).toBe("ptt");
	});

	it("neither is plain text chat", () => {
		expect(resolveVoiceMode(false, false)).toBe("text");
	});
});

describe("resolveVoiceStatus", () => {
	const base = { mode: "ptt" as const, thinking: false, transcribing: false, talking: false, listening: false };

	it("shows nothing in idle text chat", () => {
		expect(resolveVoiceStatus({ ...base, mode: "text" })).toBeNull();
	});

	it("'Working on it…' wins in EVERY mode while the agent generates (incl. text)", () => {
		for (const mode of ["text", "ptt", "handsfree"] as const) {
			const s = resolveVoiceStatus({ ...base, mode, thinking: true });
			expect(s).toMatchObject({ label: "Working on it…", tone: "work", spin: true, tap: false });
		}
	});

	it("shows a spinning 'Transcribing…' after you stop, before the reply", () => {
		expect(resolveVoiceStatus({ ...base, transcribing: true })).toMatchObject({ label: "Transcribing…", tone: "work", spin: true });
	});

	it("a recording turn is a tappable green 'Listening — tap to send'", () => {
		expect(resolveVoiceStatus({ ...base, talking: true })).toMatchObject({ label: "Listening — tap to send", tone: "live", tap: true });
	});

	it("idle Tap-to-talk invites a tap; hands-free reflects mic state", () => {
		expect(resolveVoiceStatus({ ...base, mode: "ptt" })).toMatchObject({ label: "Tap to talk", tap: true });
		expect(resolveVoiceStatus({ ...base, mode: "handsfree", listening: true })).toMatchObject({ label: "Listening…", tone: "live", tap: false });
		expect(resolveVoiceStatus({ ...base, mode: "handsfree", listening: false })).toMatchObject({ label: "Hands-free — just talk", tone: "idle" });
	});

	it("a muted hands-free mic reads 'Muted', never a false 'Listening'", () => {
		// Guards the lie where the pill claimed it was listening while the mic was paused.
		expect(resolveVoiceStatus({ ...base, mode: "handsfree", muted: true, listening: false }))
			.toMatchObject({ label: "Muted", tone: "idle", tap: false });
		// Mute doesn't override the active-work states (thinking/transcribing still win).
		expect(resolveVoiceStatus({ ...base, mode: "handsfree", muted: true, thinking: true }))
			.toMatchObject({ label: "Working on it…" });
	});

	it("prioritizes thinking over an in-flight transcribing/talking state", () => {
		expect(resolveVoiceStatus({ ...base, thinking: true, transcribing: true, talking: true }))
			.toMatchObject({ label: "Working on it…" });
	});

	it("Speaking shows in EVERY mode (mic clearly isn't hot) and is tappable to stop TTS (#128)", () => {
		for (const mode of ["text", "ptt", "handsfree"] as const) {
			expect(resolveVoiceStatus({ ...base, mode, speaking: true }))
				.toMatchObject({ label: "Speaking · tap to stop", tone: "speak", spin: false, tap: true, icon: "speak" });
		}
	});

	it("thinking beats speaking, but speaking beats listening/transcribing", () => {
		// A reply is generated (thinking) THEN spoken (speaking) — thinking wins first.
		expect(resolveVoiceStatus({ ...base, thinking: true, speaking: true }))
			.toMatchObject({ label: "Working on it…" });
		// While speaking, the mic is off — must not read "Transcribing…"/"Listening…".
		expect(resolveVoiceStatus({ ...base, mode: "handsfree", speaking: true, transcribing: true, listening: true }))
			.toMatchObject({ label: "Speaking · tap to stop", tone: "speak" });
	});

	// THE #284 BUG: the mic opens before convoOn flips, so the mode is still "text". Checked
	// below the text-mode `return null` this would never render, and the press would stay
	// unacknowledged for the whole two-await startup — the report itself.
	it("'Starting…' shows while the mode is still text (the press is acknowledged on tap)", () => {
		expect(resolveVoiceStatus({ ...base, mode: "text", starting: true }))
			.toMatchObject({ label: "Starting…", tone: "work", spin: true, tap: false, icon: "spin" });
	});
	it("starting never masks the agent's own work", () => {
		expect(resolveVoiceStatus({ ...base, starting: true, thinking: true })).toMatchObject({ label: "Working on it…" });
		expect(resolveVoiceStatus({ ...base, starting: true, speaking: true })).toMatchObject({ label: "Speaking · tap to stop" });
	});
	it("once listening begins the pill stops claiming it is starting (spinner and chime agree)", () => {
		expect(resolveVoiceStatus({ ...base, mode: "handsfree", starting: false, listening: true }))
			.toMatchObject({ label: "Listening…", tone: "live" });
	});
});

import { classifyVoiceError, micUnavailableMessage, normalizeMediaError } from "./convo.js";

describe("classifyVoiceError", () => {
	it("treats no-speech / empty as soft (recycle, no report)", () => {
		expect(classifyVoiceError(null)).toBe("soft");
		expect(classifyVoiceError("")).toBe("soft");
		expect(classifyVoiceError("no-speech")).toBe("soft");
	});
	it("treats mic permission / capture codes as mic-unavailable (stop, no report)", () => {
		expect(classifyVoiceError("not-allowed")).toBe("mic-unavailable");
		expect(classifyVoiceError("service-not-allowed")).toBe("mic-unavailable");
		expect(classifyVoiceError("audio-capture")).toBe("mic-unavailable");
	});
	it("treats genuine failures as error (report)", () => {
		expect(classifyVoiceError("Whisper error 400: ...")).toBe("error");
		expect(classifyVoiceError("aborted")).toBe("error");
	});
	it("gives a device-specific hint", () => {
		expect(micUnavailableMessage("audio-capture")).toMatch(/microphone found/i);
		expect(micUnavailableMessage("not-allowed")).toMatch(/blocked/i);
		// The case a user is least able to guess: another tab or app is holding the device.
		expect(micUnavailableMessage("audio-busy")).toMatch(/in use by another/i);
	});
});

describe("normalizeMediaError (#284 — one classifier for both ways the mic refuses)", () => {
	// THE BUG: the hands-free start path catches a getUserMedia DOMException, whose name is
	// "NotAllowedError" — a code classifyVoiceError had never heard of. It fell through to the
	// generic "error" branch, so a mic denied months ago reverted the control in silence with
	// no way for the user to learn that permission was the problem.
	it("maps a denied getUserMedia onto the Web Speech permission code", () => {
		expect(normalizeMediaError(new DOMException("denied", "NotAllowedError"))).toBe("not-allowed");
		expect(classifyVoiceError(normalizeMediaError(new DOMException("denied", "NotAllowedError")))).toBe("mic-unavailable");
	});
	it("maps a missing device onto the capture code", () => {
		expect(normalizeMediaError(new DOMException("none", "NotFoundError"))).toBe("audio-capture");
	});
	// No Web Speech equivalent exists for "another tab holds the device", which is why the
	// audio-busy code was added rather than folding it into one of the others.
	it("a device held by another tab/app becomes audio-busy, not a generic error", () => {
		expect(normalizeMediaError(new DOMException("busy", "NotReadableError"))).toBe("audio-busy");
		expect(classifyVoiceError(normalizeMediaError(new DOMException("busy", "NotReadableError")))).toBe("mic-unavailable");
	});
	it("passes a Web Speech code straight through, so the one classifier still works", () => {
		expect(normalizeMediaError("audio-capture")).toBe("audio-capture");
	});
	it("an unrecognised failure stays a real, reportable error", () => {
		expect(classifyVoiceError(normalizeMediaError(new Error("Whisper error 400")))).toBe("error");
	});
});

describe("transcriptLanguageMismatch (#126 — never assume a different language)", () => {
	it("flags a foreign-script transcript against a Latin-configured language", () => {
		expect(transcriptLanguageMismatch("안녕하세요 반갑습니다", "en-US")).toBe(true); // Korean vs English
		expect(transcriptLanguageMismatch("こんにちは、元気ですか", "es-ES")).toBe(true); // Japanese vs Spanish
	});
	it("does NOT flag the configured language", () => {
		expect(transcriptLanguageMismatch("let's fix the bug now", "en-US")).toBe(false);
		expect(transcriptLanguageMismatch("안녕하세요 반갑습니다", "ko-KR")).toBe(false); // Korean IS configured
		expect(transcriptLanguageMismatch("你好，我们开始吧", "zh-CN")).toBe(false); // Han IS configured
	});
	it("does not flag a mostly-matching sentence with a stray foreign glyph", () => {
		expect(transcriptLanguageMismatch("open the file 你 now please", "en-US")).toBe(false); // 1 foreign of many
	});
	it("stays quiet on too-little signal or an unknown configured language", () => {
		expect(transcriptLanguageMismatch("네", "en-US")).toBe(false); // 1 letter — not enough signal
		expect(transcriptLanguageMismatch("", "en-US")).toBe(false);
		expect(transcriptLanguageMismatch("안녕하세요", "xx-YY")).toBe(false); // unmapped language → never flag
	});
});

// ── unmute (#152) / exit (#165) / mute reachability (#228) ───────────────────
describe("matchVoiceCommand — unmute, gated on actually being muted", () => {
	it("matches the built-in unmute phrasings while muted", () => {
		for (const p of ["unmute", "unmute mic", "start listening", "wake up"]) {
			expect(matchVoiceCommand(p, undefined, "en-US", { muted: true })).toBe("unmute");
		}
	});

	// Without the state gate, "unmute" would fire on someone merely SAYING the word — e.g.
	// reading instructions aloud, or a reply that explains the feature.
	it("does not match unmute when not muted", () => {
		expect(matchVoiceCommand("unmute", undefined, "en-US", { muted: false })).toBeNull();
		expect(matchVoiceCommand("unmute", undefined, "en-US")).toBeNull();
	});

	// The bug this ordering exists to prevent: several languages build the unmute phrase out
	// of the mute phrase, so a mute-first check would swallow it.
	it("prefers unmute over mute in languages where one contains the other", () => {
		expect(matchVoiceCommand("stummschaltung aufheben", undefined, "de-DE", { muted: true })).toBe("unmute");
		expect(matchVoiceCommand("取消静音", undefined, "zh-CN", { muted: true })).toBe("unmute");
	});

	it("while muted, mute and repeat are inert — silence was the point", () => {
		expect(matchVoiceCommand("mute", undefined, "en-US", { muted: true })).toBeNull();
		expect(matchVoiceCommand("repeat", undefined, "en-US", { muted: true })).toBeNull();
	});

	it("keeps whole-utterance precision for unmute", () => {
		expect(matchVoiceCommand("unmute the alarm please", undefined, "en-US", { muted: true })).toBeNull();
	});
});

describe("matchVoiceCommand — exit voice mode (#165)", () => {
	it("matches exit phrasings whether muted or not — it is the way out of both", () => {
		expect(matchVoiceCommand("exit voice", undefined, "en-US", { muted: false })).toBe("exit");
		expect(matchVoiceCommand("exit voice", undefined, "en-US", { muted: true })).toBe("exit");
		expect(matchVoiceCommand("text mode", undefined, "en-US")).toBe("exit");
	});

	it("is multi-word, so it may appear inside a longer utterance", () => {
		expect(matchVoiceCommand("okay exit voice mode now", undefined, "en-US")).toBe("exit");
	});

	it("custom words replace the built-ins, as for repeat/mute", () => {
		expect(matchVoiceCommand("bye voice", { exit: ["bye voice"] }, "en-US")).toBe("exit");
		expect(matchVoiceCommand("exit voice", { exit: ["bye voice"] }, "en-US")).toBeNull();
	});
});

describe("shouldScanGateTranscript (#228)", () => {
	const base = { commandsEnabled: true, mainUsesBrowserSpeech: false, paused: false, echoing: false };

	// The actual bug: in Whisper mode the main path has no interim during capture and the
	// control listener has yielded, so the gate's words are the only ones available.
	it("scans the gate when the main path is Whisper", () => {
		expect(shouldScanGateTranscript(base)).toBe(true);
	});

	// Browser dictation already checks its own interim — scanning both would fire one spoken
	// command twice from two recognizers reading the same audio.
	it("does not scan when the main path is browser dictation", () => {
		expect(shouldScanGateTranscript({ ...base, mainUsesBrowserSpeech: true })).toBe(false);
	});

	it("respects the commands toggle", () => {
		expect(shouldScanGateTranscript({ ...base, commandsEnabled: false })).toBe(false);
	});

	// The agent's own TTS bleeding into the mic must not be able to command it.
	it("does not scan while paused or echoing", () => {
		expect(shouldScanGateTranscript({ ...base, paused: true })).toBe(false);
		expect(shouldScanGateTranscript({ ...base, echoing: true })).toBe(false);
	});
});

// ── splitTrailingCommand: a control word at the end must not eat the message ──
//
// Regression: saying "…, mute" in hands-free acted on the command and DISCARDED the turn, so
// the user dictated a request, asked for silence, and lost the request. A trailing control
// word is both a command and a finished message — the same contract stop-words already have.
describe("splitTrailingCommand", () => {
	it("keeps what the user said and reports a trailing MULTI-WORD command", () => {
		const r = splitTrailingCommand("run the tests, mute the mic", undefined, "en-US", { muted: false });
		expect(r.command).toBe("mute");
		expect(r.text).toBe("run the tests");
	});

	// Precision over convenience: phraseMatchesTranscript already refuses a single-word command
	// that isn't the whole utterance. Stripping a trailing bare word would both truncate the
	// message and take an action the user didn't ask for — much worse than not firing.
	it("does NOT treat a trailing single word as a command — that would hijack ordinary speech", () => {
		const r = splitTrailingCommand("don't forget to mute", undefined, "en-US", { muted: false });
		expect(r.command).toBeNull();
		expect(r.text).toBe("don't forget to mute");
	});

	it("a turn that IS the command sends nothing", () => {
		const r = splitTrailingCommand("mute", undefined, "en-US", { muted: false });
		expect(r.command).toBe("mute");
		expect(r.text).toBe("");
	});

	it("leaves an ordinary sentence completely alone", () => {
		const r = splitTrailingCommand("can you mute the alarm for me", undefined, "en-US", { muted: false });
		expect(r.command).toBeNull();
		expect(r.text).toBe("can you mute the alarm for me");
	});

	it("strips a multi-word command phrase, not just the last word", () => {
		const r = splitTrailingCommand("that's everything, exit voice mode", undefined, "en-US", { muted: false });
		expect(r.command).toBe("exit");
		expect(r.text).toBe("that's everything");
	});

	it("honours the muted state — unmute is only a candidate while muted", () => {
		expect(splitTrailingCommand("okay start listening", undefined, "en-US", { muted: true }).command).toBe("unmute");
		expect(splitTrailingCommand("okay start listening", undefined, "en-US", { muted: false }).command).toBeNull();
		// bare word, whole utterance → still a command, as matchVoiceCommand has always had it
		expect(splitTrailingCommand("unmute", undefined, "en-US", { muted: true })).toEqual({ command: "unmute", text: "" });
	});

	it("uses custom words when set, like every other command path", () => {
		const r = splitTrailingCommand("ship it now, hush please", { mute: ["hush please"] }, "en-US", { muted: false });
		expect(r.command).toBe("mute");
		expect(r.text).toBe("ship it now");
	});

	it("tolerates trailing punctuation around the command", () => {
		expect(splitTrailingCommand("done for now, exit voice mode.", undefined, "en-US", { muted: false }).text).toBe("done for now");
	});

	// The bug that started this: a multi-word phrase appearing mid-sentence made
	// matchVoiceCommand report a command, and the caller then dropped the whole turn.
	it("does not strip a command phrase that is not at the end", () => {
		const r = splitTrailingCommand("exit voice mode is the phrase I keep forgetting", undefined, "en-US", { muted: false });
		expect(r.text).toBe("exit voice mode is the phrase I keep forgetting");
	});
});

// ── #331: "stop" alone is a command ────────────────────────────────────────────────────────
//
// Every English exit phrase used to require "voice" after the verb, so bare "stop" was sent to
// the agent as a message. The agent, which cannot see or change client-side voice state, replied
// "Got it. Stopped." — a confirmation of something nobody did — and the user disengaged with the
// mic still open. The next two turns were phantom (#332).
describe('matchVoiceCommand — bare "stop" (#331)', () => {
	it("exits voice when the whole utterance IS stop, in any rendering", () => {
		for (const utterance of ["stop", "Stop.", "STOP!", "Stop-stop.", "stop stop"]) {
			expect(matchVoiceCommand(utterance, undefined, "en-US")).toBe("exit");
		}
	});

	it("still exits while muted — mute silences the mic, it does not trap you in voice", () => {
		expect(matchVoiceCommand("Stop.", undefined, "en-US", { muted: true })).toBe("exit");
	});

	// The single-word rule (a bare phrase must BE the whole utterance) is what makes this safe.
	// It was added when "next agent" fired inside "the next agent in the chain is the builder";
	// it is the same rule keeping ordinary speech about stopping a message.
	it("does NOT hijack ordinary speech that merely contains the word", () => {
		for (const sentence of ["don't stop now", "stop the deploy when the tests go green", "we should stop", "did it stop?"]) {
			expect(matchVoiceCommand(sentence, undefined, "en-US")).toBeNull();
		}
	});

	// "stop listening" says literally what mute does, and exit is checked first — so adding the
	// bare word must not have quietly stolen it.
	it("leaves 'stop listening' as MUTE", () => {
		expect(matchVoiceCommand("stop listening", undefined, "en-US")).toBe("mute");
	});

	it("has an equivalent in every language that already had exit phrases", () => {
		expect(matchVoiceCommand("停止", undefined, "zh-CN")).toBe("exit");
		expect(matchVoiceCommand("やめて", undefined, "ja-JP")).toBe("exit");
		expect(matchVoiceCommand("그만", undefined, "ko-KR")).toBe("exit");
		expect(matchVoiceCommand("basta", undefined, "es-ES")).toBe("exit");
		expect(matchVoiceCommand("arrête", undefined, "fr-FR")).toBe("exit");
		expect(matchVoiceCommand("aufhören", undefined, "de-DE")).toBe("exit");
		expect(matchVoiceCommand("रुको", undefined, "hi-IN")).toBe("exit");
	});

	// A turn that IS the command sends nothing; a turn that ENDS with the doubled imperative
	// keeps what came before, the same contract every other trailing command has.
	it("sends nothing when the turn is only the stop word", () => {
		expect(splitTrailingCommand("Stop-stop.", undefined, "en-US", { muted: false })).toEqual({ command: "exit", text: "" });
		expect(splitTrailingCommand("Stop.", undefined, "en-US", { muted: false })).toEqual({ command: "exit", text: "" });
	});
});

describe("commandPhrases", () => {
	it("returns the built-ins for the language, and custom words when set", () => {
		expect(commandPhrases("mute", undefined, "en-US")).toContain("mute");
		expect(commandPhrases("mute", undefined, "de-DE")).toContain("stumm");
		expect(commandPhrases("mute", { mute: ["shush"] }, "en-US")).toEqual(["shush"]);
	});

	it("falls back to English for a language with no table entry", () => {
		expect(commandPhrases("unmute", undefined, "sv-SE")).toContain("unmute");
	});

	// A table lookup that forgot a command used to fall through to the EXIT phrases, which in
	// splitTrailingCommand would strip the wrong words off the end of a real message.
	it("has its own phrases for every command in the vocabulary", () => {
		expect(commandPhrases("next", undefined, "en")).toContain("next");
		expect(commandPhrases("next", undefined, "en")).not.toContain("exit voice");
		expect(commandPhrases("exit", undefined, "en")).toContain("exit voice");
	});
});

describe('matchVoiceCommand — "next" (#277: switch agent without touching the screen)', () => {
	const CAN = { canSwitch: true };

	it("fires when the utterance IS the command", () => {
		expect(matchVoiceCommand("next", undefined, "en", CAN)).toBe("next");
		expect(matchVoiceCommand("Next.", undefined, "en", CAN)).toBe("next");
		expect(matchVoiceCommand("switch agent", undefined, "en", CAN)).toBe("next");
	});

	// The ticket's own verification bullet, and the reason the bare word is whole-utterance
	// only: a question ABOUT the work must never steer the app somewhere else.
	it('"what\'s next for this repo?" is a MESSAGE, never the command', () => {
		expect(matchVoiceCommand("what's next for this repo?", undefined, "en", CAN)).toBeNull();
		expect(matchVoiceCommand("tell me what to do next", undefined, "en", CAN)).toBeNull();
	});

	// Why the table carries no noun phrases: a multi-word phrase matches as a whole-word run
	// ANYWHERE in an utterance, so "next agent" would teleport a user mid-sentence out of a
	// conversation about agents — which is most of what people say to a coordinator.
	it("a sentence ABOUT agents is not a command to leave", () => {
		expect(matchVoiceCommand("the next agent in the chain is the builder", undefined, "en", CAN)).toBeNull();
		expect(matchVoiceCommand("show me the next agent's board", undefined, "en", CAN)).toBeNull();
	});

	// The voice stack has no idea what an agent roster is. A surface with no switcher (the
	// Coder's Co-pilot) must pass "next" through as ordinary speech rather than swallow it
	// into a command nothing can act on.
	it("is inert unless the consumer can actually switch", () => {
		expect(matchVoiceCommand("next", undefined, "en")).toBeNull();
		expect(matchVoiceCommand("next", undefined, "en", { canSwitch: false })).toBeNull();
	});

	// Mute silences the microphone, not the user's ability to leave. Being unable to walk away
	// from a muted agent without the screen is the exact failure #277 exists to remove.
	it("still fires while muted — mute is about the mic, not about being trapped", () => {
		expect(matchVoiceCommand("next", undefined, "en", { muted: true, canSwitch: true })).toBe("next");
		// …and the muted branch still refuses the commands that are meaningless there.
		expect(matchVoiceCommand("repeat", undefined, "en", { muted: true, canSwitch: true })).toBeNull();
	});

	it("respects the per-language table and custom overrides", () => {
		expect(matchVoiceCommand("下一个", undefined, "zh", CAN)).toBe("next");
		expect(matchVoiceCommand("next", undefined, "zh", CAN)).toBeNull(); // English words on a Chinese agent
		expect(matchVoiceCommand("hop", { next: ["hop"] }, "en", CAN)).toBe("next");
		expect(matchVoiceCommand("next", { next: ["hop"] }, "en", CAN)).toBeNull(); // custom REPLACES built-ins
	});

	// The other four commands must behave exactly as before for a consumer that never opts in.
	it("does not disturb the existing vocabulary", () => {
		expect(matchVoiceCommand("repeat", undefined, "en")).toBe("repeat");
		expect(matchVoiceCommand("mute", undefined, "en")).toBe("mute");
		expect(matchVoiceCommand("wake up", undefined, "en", { muted: true })).toBe("unmute");
		expect(matchVoiceCommand("exit voice", undefined, "en")).toBe("exit");
	});
});

describe('splitTrailingCommand — "next" (#277)', () => {
	// The contract every other command already has: a control word at the end is BOTH a command
	// and a finished message. Dropping the message would mean asking a question and being moved
	// away before it was ever asked.
	it("sends what came before, then switches", () => {
		const r = splitTrailingCommand("deploy the worker, switch agent", undefined, "en", { canSwitch: true });
		expect(r.command).toBe("next");
		expect(r.text).toBe("deploy the worker");
	});

	it("an utterance that IS the command sends nothing", () => {
		expect(splitTrailingCommand("next", undefined, "en", { canSwitch: true })).toEqual({ command: "next", text: "" });
	});

	it("is inert without canSwitch, so the words stay in the message", () => {
		const r = splitTrailingCommand("deploy the worker, switch agent", undefined, "en");
		expect(r.command).toBeNull();
		expect(r.text).toBe("deploy the worker, switch agent");
	});
});
