import { describe, expect, it } from "vitest";
import { decideRestart, matchVoiceCommand, resolveVoiceMode, resolveVoiceStatus, shouldRunControlListener, stripStopWord, transcriptLanguageMismatch } from "./convo.js";

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
});

import { classifyVoiceError, micUnavailableMessage } from "./convo.js";

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
