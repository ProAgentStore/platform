import { describe, expect, it } from "vitest";
import { ALL_VOICE_COMMANDS, commandPhrases, commandStateFor, decideRestart, matchesStopSpeech, matchVoiceCommand, planRestartBail, resolveVoiceMode, resolveVoiceStatus, shouldRunControlListener, shouldScanGateTranscript, splitTrailingCommand, stripStopWord, transcriptLanguageMismatch, type VoiceCommand } from "./convo.js";

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

import { classifyVoiceError, isMicPermissionDenied, isReportableMicError, isRetryableVoiceError, micUnavailableMessage, normalizeMediaError } from "./convo.js";
import { TRANSCRIBE_TIMEOUT_MESSAGE } from "./stt.js";
import { collapseRepeatedRuns } from "./normalize.js";

/**
 * #421 — "users need to see the message and know what to do, retry now or later".
 *
 * The clip is still in hand after any failure, so Retry is a re-POST rather than "say that again".
 * Which failures deserve the button is the whole question: a timeout will very likely succeed on a
 * second attempt, a 401 will fail identically and the attempt bills the user's own OpenAI key to
 * discover that.
 */
describe("isRetryableVoiceError", () => {
	it("offers a retry for the failures a second attempt could change", () => {
		for (const err of [TRANSCRIBE_TIMEOUT_MESSAGE, "Whisper error 500: upstream", "Whisper error 503: busy", "ProAgentStore is updating — try that again in a moment.", "Transcription stream failed: network error", "Whisper failed: Load failed"]) {
			expect(isRetryableVoiceError(err), `${err} should offer Retry`).toBe(true);
		}
	});
	it("withholds it for a refusal that is deterministic — the same clip and key answer the same", () => {
		for (const err of ["Whisper error 400: audio file is too short", "Whisper error 401: invalid api key", "Whisper error 403: forbidden", "not-allowed", "audio-capture"]) {
			expect(isRetryableVoiceError(err), `${err} must NOT offer Retry`).toBe(false);
		}
	});
	it("is conservative about what it has never seen — a dead button costs real money to discover", () => {
		expect(isRetryableVoiceError("something nobody has classified")).toBe(false);
		expect(isRetryableVoiceError(null)).toBe(false);
		expect(isRetryableVoiceError(undefined)).toBe(false);
	});
	it("reads a 4xx as final even though the word 'error' is in every one of these strings", () => {
		// The ordering trap: "Whisper error 400: …" matches nothing in the retryable list today,
		// but "Whisper failed" does — so the refusal check has to come first and stay first.
		expect(isRetryableVoiceError("Whisper failed: 400 invalid request")).toBe(false);
	});
});

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
	/**
	 * #425 — two questions about one error code, and they have different answers.
	 *
	 * PAGS runs THREE recognizers over one microphone and two of them re-arm forever. Whether a
	 * code is worth a durable ROW and whether it should STOP the re-arm loop are separate, because
	 * getting the second one too wide is how mute-by-voice would be disabled by a transient.
	 */
	it("reports a background recognizer's refusal, and its missing device, but not its churn", () => {
		for (const code of ["not-allowed", "service-not-allowed", "audio-capture"]) {
			expect(isReportableMicError(code), `${code} should reach the durable log`).toBe(true);
		}
		// The codes these handlers exist to ignore. Reporting them would flood the log on a path
		// that fires every few seconds while voice is engaged (see #423).
		for (const code of ["no-speech", "aborted", "network", "", null, undefined]) {
			expect(isReportableMicError(code), `${code} must not be reported`).toBe(false);
		}
	});

	it("stops re-arming ONLY for a verdict the browser cannot produce by contention", () => {
		expect(isMicPermissionDenied("not-allowed")).toBe(true);
		expect(isMicPermissionDenied("service-not-allowed")).toBe(true);
		// The important negative. `audio-capture` can be two recognizers fighting over one device;
		// latching on it would permanently disable the always-on control listener, i.e. delete
		// mute-by-voice for the rest of the session — the exact ADR 0001 M1 failure #425 is meant
		// to expose rather than cause.
		expect(isMicPermissionDenied("audio-capture"), "a transient device conflict must not disable mute-by-voice (ADR 0001 M1)").toBe(false);
		for (const code of ["no-speech", "aborted", "network", "", null, undefined]) expect(isMicPermissionDenied(code)).toBe(false);
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

describe('matchVoiceCommand — "back" (#279: reversing an agent-mediated transfer)', () => {
	const CAN = { canBack: true };

	it("fires when the utterance IS the phrase", () => {
		expect(matchVoiceCommand("go back", undefined, "en", CAN)).toBe("back");
		expect(matchVoiceCommand("Go back.", undefined, "en", CAN)).toBe("back");
		expect(matchVoiceCommand("take me back", undefined, "en", CAN)).toBe("back");
		expect(matchVoiceCommand("previous agent", undefined, "en", CAN)).toBe("back");
	});

	// The reason this command is whole-utterance only where "next" is not: every phrase for it is
	// ordinary English in the middle of a sentence, and a whole-word run would fire on all of these.
	it("a sentence that merely CONTAINS the phrase is a message", () => {
		expect(matchVoiceCommand("let's go back and fix the parser", undefined, "en", CAN)).toBeNull();
		expect(matchVoiceCommand("can you take me back to the previous version", undefined, "en", CAN)).toBeNull();
		expect(matchVoiceCommand("what did the previous agent say", undefined, "en", CAN)).toBeNull();
	});

	it("is inert unless the consumer can actually go back", () => {
		expect(matchVoiceCommand("go back", undefined, "en")).toBeNull();
		expect(matchVoiceCommand("go back", undefined, "en", { canBack: false })).toBeNull();
	});

	// Same rule as "next", for the same reason: mute silences the microphone, not the ability to
	// leave. Being unable to reverse a transfer without unmuting first puts the screen back in the
	// loop at exactly the moment the user realises they are in the wrong conversation.
	it("still fires while muted", () => {
		expect(matchVoiceCommand("go back", undefined, "en", { muted: true, canBack: true })).toBe("back");
	});

	// "back to text" is an EXIT phrase and exit is checked first. Leaving voice is the smaller,
	// recoverable reading of an ambiguous "back", so it keeps the phrase.
	it("does not steal the exit vocabulary", () => {
		expect(matchVoiceCommand("back to text", undefined, "en", CAN)).toBe("exit");
	});

	it("respects the per-language table", () => {
		expect(matchVoiceCommand("回到上一个", undefined, "zh", CAN)).toBe("back");
		expect(matchVoiceCommand("go back", undefined, "zh", CAN)).toBeNull();
	});

	// The other commands must behave exactly as before for a consumer that never opts in.
	it("does not disturb the existing vocabulary", () => {
		expect(matchVoiceCommand("next", undefined, "en", { canSwitch: true })).toBe("next");
		expect(matchVoiceCommand("scrap that", undefined, "en", { canScrap: true })).toBe("scrap");
		expect(matchVoiceCommand("mute", undefined, "en")).toBe("mute");
	});
});

describe('splitTrailingCommand — "back" is deliberately not a candidate (#279)', () => {
	it("leaves a trailing go-back in the message rather than acting on it", () => {
		// "ask it about the parser, then take me back" is a sentence about a plan, not two
		// instructions, and the trailing form cannot tell the difference.
		const r = splitTrailingCommand("ask it about the parser, then take me back", undefined, "en", { canSwitch: true });
		expect(r.command).toBeNull();
		expect(r.text).toBe("ask it about the parser, then take me back");
	});
});

describe('matchVoiceCommand — "scrap" (#342: the first DESTRUCTIVE command in the vocabulary)', () => {
	const CAN = { canScrap: true };

	it("fires when the utterance IS the phrase", () => {
		expect(matchVoiceCommand("scrap that", undefined, "en", CAN)).toBe("scrap");
		expect(matchVoiceCommand("Scrap that.", undefined, "en", CAN)).toBe("scrap");
		expect(matchVoiceCommand("scratch that", undefined, "en", CAN)).toBe("scrap");
		expect(matchVoiceCommand("delete last message", undefined, "en", CAN)).toBe("scrap");
	});

	// Whisper renders an emphatic pair as a hyphenated compound sometimes — the #334 near-miss.
	// The shared normaliser spaces punctuation in every script, so this holds by construction; the
	// test pins it, because a destructive command cannot afford intermittency.
	it("survives the punctuation the user cannot see or control", () => {
		expect(matchVoiceCommand("scrap-that", undefined, "en", CAN)).toBe("scrap");
		expect(matchVoiceCommand("  SCRAP   THAT!!  ", undefined, "en", CAN)).toBe("scrap");
	});

	// THE reason this command does not use the ordinary multi-word rule. A multi-word phrase
	// normally matches as a whole-word run anywhere in an utterance; both of these contain
	// "scrap that", and the first is the user explicitly REFUSING the action.
	it("does not fire inside a sentence that merely contains the phrase", () => {
		expect(matchVoiceCommand("don't scrap that, keep it", undefined, "en", CAN)).toBeNull();
		expect(matchVoiceCommand("scrap that idea and let's move on", undefined, "en", CAN)).toBeNull();
		expect(matchVoiceCommand("we should scrap that approach", undefined, "en", CAN)).toBeNull();
		expect(matchVoiceCommand("ignore that warning for now", undefined, "en", CAN)).toBeNull();
	});

	// A subscriber says this to the Coder about a file constantly, and the whole-utterance rule
	// cannot tell the two readings apart — so the bare form is not in the table at all.
	it('bare "delete that" is left alone — its likeliest meaning is a file, not a turn', () => {
		expect(matchVoiceCommand("delete that", undefined, "en", CAN)).toBeNull();
	});

	// The gate. A surface with no delete path passes the words through as speech, and the same
	// flag is what callers drop on INTERIM transcripts so a partial can never fire a delete.
	it("is inert unless the consumer opted in", () => {
		expect(matchVoiceCommand("scrap that", undefined, "en")).toBeNull();
		expect(matchVoiceCommand("scrap that", undefined, "en", { canScrap: false })).toBeNull();
	});

	// Muted means the mic is closed; the always-on control listener still runs, and a destructive
	// command reached through it would act on audio the user believes is not being heard.
	it("does not fire while muted", () => {
		expect(matchVoiceCommand("scrap that", undefined, "en", { muted: true, canScrap: true })).toBeNull();
	});

	it("respects the per-language table and custom overrides", () => {
		expect(matchVoiceCommand("取消这条", undefined, "zh", CAN)).toBe("scrap");
		expect(matchVoiceCommand("scrap that", undefined, "zh", CAN)).toBeNull();
		expect(matchVoiceCommand("bin it", { scrap: ["bin it"] }, "en", CAN)).toBe("scrap");
		expect(matchVoiceCommand("scrap that", { scrap: ["bin it"] }, "en", CAN)).toBeNull();
	});

	it("does not disturb the existing vocabulary", () => {
		expect(matchVoiceCommand("repeat", undefined, "en", CAN)).toBe("repeat");
		expect(matchVoiceCommand("mute", undefined, "en", CAN)).toBe("mute");
		expect(matchVoiceCommand("exit voice", undefined, "en", CAN)).toBe("exit");
		expect(matchVoiceCommand("wake up", undefined, "en", { muted: true, canScrap: true })).toBe("unmute");
	});
});

describe('splitTrailingCommand — "scrap" is deliberately not a candidate (#342)', () => {
	// The trailing form is the dangerous one: acting on it would delete the previous exchange AND
	// send a truncated request. A whole-utterance command has no message half to keep, so the
	// splitter never learns the word and these stay ordinary speech.
	it("leaves a trailing scrap phrase in the message", () => {
		const r = splitTrailingCommand("let's rewrite the parser, scrap that", undefined, "en", { canSwitch: true });
		expect(r.command).toBeNull();
		expect(r.text).toBe("let's rewrite the parser, scrap that");
	});
});

describe("commandStateFor", () => {
	it("drops the destructive flag on a PARTIAL, even when the consumer can delete", () => {
		// The three live-partial call sites pass `canScrap: true` and get `false` back. That is
		// the point: the flag is refused on the way IN rather than never passed, so the rule
		// cannot be undone by a reader who notices one site "missing" what its siblings have.
		expect(commandStateFor("partial", { canScrap: true })).toEqual({ muted: false, canSwitch: false, canScrap: false, canBack: false, judgeable: true, whole: false });
		expect(commandStateFor("final", { canScrap: true })).toEqual({ muted: false, canSwitch: false, canScrap: true, canBack: false, judgeable: true, whole: false });
	});

	it("makes the same words a delete on a final and ordinary speech on a partial", () => {
		const partial = commandStateFor("partial", { canScrap: true, canSwitch: true });
		const final = commandStateFor("final", { canScrap: true, canSwitch: true });
		expect(matchVoiceCommand("scrap that", undefined, "en", partial)).toBeNull();
		expect(matchVoiceCommand("scrap that", undefined, "en", final)).toBe("scrap");
		// Everything else is unaffected by the kind — only the destructive word is withheld,
		// so a partial keeps catching "mute" the instant it is spoken (#153/#228).
		for (const [text, cmd] of [
			["mute", "mute"],
			["exit voice", "exit"],
			["repeat", "repeat"],
			["switch agent", "next"],
		] as const) {
			expect(matchVoiceCommand(text, undefined, "en", partial), text).toBe(cmd);
			expect(matchVoiceCommand(text, undefined, "en", final), text).toBe(cmd);
		}
	});

	it("passes muted and canSwitch through as booleans, defaulting to off", () => {
		expect(commandStateFor("final", {})).toEqual({ muted: false, canSwitch: false, canScrap: false, canBack: false, judgeable: true, whole: false });
		expect(commandStateFor("final", { muted: true, canSwitch: true })).toEqual({ muted: true, canSwitch: true, canScrap: false, canBack: false, judgeable: true, whole: false });
	});

	it("drops the go-back flag on a PARTIAL too, for a different reason than scrap's (#279)", () => {
		// Not destructiveness — every phrase for "back" is ordinary speech, and a partial is exactly
		// "go back" on the way to "go back and fix the parser". Same treatment, refused on the way IN.
		expect(commandStateFor("partial", { canBack: true }).canBack).toBe(false);
		expect(commandStateFor("final", { canBack: true }).canBack).toBe(true);
		expect(matchVoiceCommand("go back", undefined, "en", commandStateFor("partial", { canBack: true }))).toBeNull();
		expect(matchVoiceCommand("go back", undefined, "en", commandStateFor("final", { canBack: true }))).toBe("back");
	});
});

describe("matchesStopSpeech", () => {
	const speaking = { ttsSpeaking: true };

	it("matches as a substring, case-insensitively — it interrupts, so mid-sentence counts", () => {
		expect(matchesStopSpeech({ keyword: "stop", text: "okay STOP please", ...speaking })).toBe(true);
		expect(matchesStopSpeech({ keyword: "STOP", text: "okay stop please", ...speaking })).toBe(true);
	});

	it("is inert unless the agent is actually talking — there is nothing to interrupt", () => {
		expect(matchesStopSpeech({ keyword: "stop", text: "stop", ttsSpeaking: false })).toBe(false);
	});

	it("is off when no keyword is configured", () => {
		expect(matchesStopSpeech({ keyword: "", text: "anything at all", ...speaking })).toBe(false);
		expect(matchesStopSpeech({ keyword: undefined, text: "anything at all", ...speaking })).toBe(false);
	});

	it("treats a whitespace-only keyword as OFF, not as 'any text containing a space'", () => {
		// The emptiness test used to run on the un-trimmed setting, so a keyword of " " halted
		// playback on almost every result the control listener saw.
		expect(matchesStopSpeech({ keyword: "   ", text: "tell me about the parser", ...speaking })).toBe(false);
	});

	it("does not match text without the keyword", () => {
		expect(matchesStopSpeech({ keyword: "stop", text: "keep going", ...speaking })).toBe(false);
	});
});

describe("precedence: an explicit binding outranks a built-in (#385)", () => {
	// The reported account, verbatim: exitWords never set, stopSpeechKeyword explicitly set to the
	// phrase the built-in English exit list happens to own. Saying it while the agent was silent
	// tore hands-free down — the destructive reading, and the one the user never chose.
	const REPORTED = { stopSpeech: "stop stop" };

	it("does not exit on a phrase the user bound to stop-speech", () => {
		expect(matchVoiceCommand("stop stop", REPORTED, "en-US")).toBeNull();
		expect(matchVoiceCommand("Stop-stop.", REPORTED, "en-US")).toBeNull(); // #334 normalisation
		expect(commandPhrases("exit", REPORTED, "en-US")).not.toContain("stop stop");
	});

	it("leaves the REST of the exit list working — only the colliding phrase is given up", () => {
		for (const utterance of ["exit voice", "text mode", "back to text"]) {
			expect(matchVoiceCommand(utterance, REPORTED, "en-US"), utterance).toBe("exit");
		}
		// "stop stop" was reserved, bare "stop" was not: the keyword is not a substring of it, so
		// nothing the user bound would fire on that word.
		expect(matchVoiceCommand("stop", REPORTED, "en-US")).toBe("exit");
	});

	// matchesStopSpeech is a SUBSTRING matcher, so the reservation has to be as wide as it is:
	// saying "stop stop" IS saying "stop", and the explicit binding is what the user chose.
	it("a one-word stop-speech keyword also reserves the built-ins that contain it", () => {
		const bound = { stopSpeech: "stop" };
		expect(matchVoiceCommand("stop", bound, "en-US")).toBeNull();
		expect(matchVoiceCommand("stop stop", bound, "en-US")).toBeNull();
		expect(matchVoiceCommand("exit voice", bound, "en-US")).toBe("exit"); // untouched
		// "stop listening" contains it too, so it goes with it rather than firing a different
		// action on a phrase the user has claimed.
		expect(matchVoiceCommand("stop listening", bound, "en-US")).toBeNull();
	});

	it("applies between command lists too, in whichever order they are checked", () => {
		// exit is matched BEFORE mute, so without this rule the built-in exit "stop" would win
		// over a mute the user typed themselves.
		expect(matchVoiceCommand("stop", { mute: ["stop"] }, "en-US")).toBe("mute");
		// And the reverse direction: a bound exit phrase is not re-read as a repeat.
		expect(matchVoiceCommand("pardon", { exit: ["pardon"] }, "en-US")).toBe("exit");
	});

	it("carries the same rule into splitTrailingCommand, which strips words off a real message", () => {
		// Without the shared rule the two disagree: the matcher says "not a command", the splitter
		// still amputates the phrase from the end of the sentence it is part of.
		expect(splitTrailingCommand("stop stop", REPORTED, "en-US", { muted: false })).toEqual({ command: null, text: "stop stop" });
	});

	it("changes nothing for a user who bound nothing — blank still means 'use ours'", () => {
		for (const utterance of ["stop", "stop stop", "exit voice", "mute", "repeat"]) {
			expect(matchVoiceCommand(utterance, undefined, "en-US"), utterance).toBe(matchVoiceCommand(utterance, {}, "en-US"));
		}
		expect(matchVoiceCommand("stop stop", {}, "en-US")).toBe("exit");
	});
});

describe("the agent's own voice cannot issue commands (#386)", () => {
	const echoing = (kind: "partial" | "final") => commandStateFor(kind, { canSwitch: true, echoing: true });

	// The concrete failure: the agent says "Stop me if this is wrong", the control listener's first
	// interim is exactly "stop", the whole-utterance rule matches the built-in exit word, and
	// hands-free is torn down with the user having said nothing.
	it("judges no PARTIAL while the agent may be in the microphone", () => {
		expect(matchVoiceCommand("stop", undefined, "en", echoing("partial"))).toBeNull();
		expect(matchVoiceCommand("mute", undefined, "en", echoing("partial"))).toBeNull();
		expect(matchVoiceCommand("next", undefined, "en", echoing("partial"))).toBeNull();
	});

	it("still honours a deliberate command on the FINAL — #153's whole capability survives", () => {
		expect(matchVoiceCommand("mute", undefined, "en", echoing("final"))).toBe("mute");
		expect(matchVoiceCommand("mute mute", { mute: ["mute mute"] }, "en", echoing("final"))).toBe("mute");
		expect(matchVoiceCommand("unmute", undefined, "en", commandStateFor("final", { muted: true, echoing: true }))).toBe("unmute");
	});

	it("refuses a multi-word phrase buried in a longer sentence while the agent speaks", () => {
		// An agent explaining its own controls, and a coordinator naming the next agent — both fire
		// today, because a multi-word phrase may match as a run inside a longer utterance.
		expect(matchVoiceCommand("say mute mute to silence me", { mute: ["mute mute"] }, "en", echoing("final"))).toBeNull();
		expect(matchVoiceCommand("the switch agent step is next", undefined, "en", echoing("final"))).toBeNull();
		// …and outside the echo window that same sentence is still a command, unchanged.
		expect(matchVoiceCommand("okay mute mute now", { mute: ["mute mute"] }, "en", commandStateFor("final", {}))).toBe("mute");
	});

	it("does not swallow single words wholesale — a real 'commit' still reaches the agent (#377)", () => {
		expect(matchVoiceCommand("commit", undefined, "en", echoing("final"))).toBeNull();
		expect(matchVoiceCommand("commit", undefined, "en", echoing("partial"))).toBeNull();
	});

	it("is inert when the agent is silent — every existing call site is byte-identical", () => {
		for (const kind of ["partial", "final"] as const) {
			expect(commandStateFor(kind, { canScrap: true, canSwitch: true, muted: true })).toEqual(
				commandStateFor(kind, { canScrap: true, canSwitch: true, muted: true, echoing: false }),
			);
		}
		expect(commandStateFor("partial", { echoing: true }).judgeable).toBe(false);
		expect(commandStateFor("final", { echoing: true }).whole).toBe(true);
	});
});

describe("planRestartBail (#387 — hands-free never gives up in silence)", () => {
	it("says what happened AND what to try, and does not expire", () => {
		const plan = planRestartBail({ rapidEnds: 4, sttWhisper: false });
		expect(plan.notice).toMatch(/hands-free/i);
		expect(plan.notice).toMatch(/mic/i);
		// Every cause is user-fixable and only if named — a notice that does not say what to do
		// leaves the user with "hands-free is flaky", the conclusion this exists to prevent.
		expect(plan.notice).toMatch(/allowed|permission|tab|app/i);
	});

	it("reports a FIXED message with the varying detail in the context", () => {
		// reportClientError de-dups on source+message, so a burst must collapse to ONE row.
		const a = planRestartBail({ rapidEnds: 4, sttWhisper: false });
		const b = planRestartBail({ rapidEnds: 9, sttWhisper: true });
		expect(a.report).toBe(b.report);
		expect(a.report).toBeTruthy();
		expect(a.context).toEqual({ rapidEnds: 4, sttWhisper: false });
		expect(b.context).toEqual({ rapidEnds: 9, sttWhisper: true });
	});

	it("gets the count from the decision that bailed — nextRapidEnds is reset and cannot say", () => {
		const d = decideRestart(50, 3);
		expect(d.bail).toBe(true);
		expect(d.nextRapidEnds).toBe(0);
		expect(d.rapidEnds).toBe(4);
		expect(planRestartBail({ rapidEnds: d.rapidEnds, sttWhisper: false }).context.rapidEnds).toBe(4);
	});
});

/**
 * #456 — "Saying 'mute' once works. Saying it twice does nothing — and ships the word to the agent
 * as a chat message." Live from `bd43f4de-…`:
 *
 *     10:58:14  user | "Yes, of course, push, everything has to be pushed."
 *     10:58:54  user | "Mute, mute, mute, mute, mute"
 *
 * The second message IS the command, five times over, delivered to the model as a chat turn.
 * Repetition is what a user does when the first attempt appears not to have worked, so the natural
 * recovery action was the one guaranteed to fail — and it published the attempt into the
 * conversation. ADR 0001 M1 says mute is reachable in every phase.
 */
describe("a repeated command word is a command, not a message (#456)", () => {
	const notMuted = { muted: false, canSwitch: false };

	it("fires mute at one, two and five repetitions, and sends nothing", () => {
		for (const said of ["mute", "Mute, mute", "mute mute", "Mute, mute, mute, mute, mute"]) {
			expect(matchVoiceCommand(said, undefined, "en", { muted: false }), said).toBe("mute");
			expect(splitTrailingCommand(said, undefined, "en", notMuted), said).toEqual({ command: "mute", text: "" });
		}
	});

	// THE PRECISION RULE THAT MUST SURVIVE. A bare trailing command word is genuinely ambiguous,
	// and truncating a sentence is the expensive mistake — so one stays a message.
	it("leaves a single trailing command word alone, which is why the threshold is two", () => {
		for (const said of ["don't forget to mute", "push everything, mute", "remind me to unmute later"]) {
			expect(matchVoiceCommand(said, undefined, "en", { muted: false }), said).toBeNull();
			expect(splitTrailingCommand(said, undefined, "en", notMuted), said).toEqual({ command: null, text: said });
		}
	});

	it("strips a REPEATED trailing run and keeps the message that came before it", () => {
		expect(splitTrailingCommand("push everything, mute mute", undefined, "en", notMuted)).toEqual({
			command: "mute",
			text: "push everything",
		});
		expect(splitTrailingCommand("Run the tests, mute mute mute.", undefined, "en", notMuted)).toEqual({
			command: "mute",
			text: "Run the tests",
		});
	});

	// The other repeatable commands, in the states they are meaningful in. `unmute` is checked only
	// while muted and `exit` in both, so the coverage has to follow the candidate list.
	it("covers the other repeatable commands, not just mute", () => {
		expect(matchVoiceCommand("unmute unmute unmute", undefined, "en", { muted: true })).toBe("unmute");
		expect(splitTrailingCommand("unmute unmute", undefined, "en", { muted: true })).toEqual({ command: "unmute", text: "" });
		expect(matchVoiceCommand("stop stop stop stop", undefined, "en", { muted: false })).toBe("exit");
	});

	/**
	 * Every configured language, derived from the built-in tables rather than transcribed — a
	 * hand-written list would drift the moment a language is added, and #456's acceptance criterion
	 * is about all of them.
	 */
	it("works in every language a command ships in", () => {
		for (const lang of ["en", "es", "fr", "de", "it", "pt", "zh", "ja", "ko", "hi"]) {
			for (const command of ["mute", "unmute", "exit"] as const) {
				const phrase = commandPhrases(command, undefined, lang)[0];
				const muted = command === "unmute";
				const doubled = `${phrase} ${phrase}`;
				expect(matchVoiceCommand(doubled, undefined, lang, { muted }), `${lang}/${command}: "${doubled}"`).toBe(command);
			}
		}
	});

	// A script that writes without spaces arrives as ONE token, so token folding alone would miss
	// it — the second rule in `collapseRepeatedRuns` is what covers `"静音静音静音"`.
	it("folds a repetition that arrives with no separator at all", () => {
		expect(matchVoiceCommand("静音静音静音", undefined, "zh", { muted: false })).toBe("mute");
		expect(matchVoiceCommand("停停", undefined, "zh", { muted: false })).toBe("exit");
	});

	/**
	 * The regression the fix is shaped to avoid. Folding inside `normalizeSpeech` would have reached
	 * the transcript comparison and the noise filter, where a legitimately doubled word must
	 * survive. This folds only while a command match is being evaluated, and only after the raw
	 * transcript has already been tried.
	 */
	it("does not touch ordinary speech that happens to repeat a word", () => {
		for (const said of ["very very good work", "I said no no to that", "that that is fine"]) {
			expect(matchVoiceCommand(said, undefined, "en", { muted: false }), said).toBeNull();
			expect(splitTrailingCommand(said, undefined, "en", notMuted), said).toEqual({ command: null, text: said });
		}
	});

	it("folds only what it claims to fold", () => {
		expect(collapseRepeatedRuns("mute mute mute mute mute")).toBe("mute");
		expect(collapseRepeatedRuns("push everything mute mute")).toBe("push everything mute");
		expect(collapseRepeatedRuns("very very good")).toBe("very good"); // harmless: matches no command
		expect(collapseRepeatedRuns("停停")).toBe("停");
		expect(collapseRepeatedRuns("mute")).toBe("mute");
		expect(collapseRepeatedRuns("")).toBe("");
	});
});

/**
 * #443 — "exit cannot be turned off at all." The replacement for #385's fix (1), which proposed
 * making a blank field mean OFF, backfilled with today's built-ins. That was measured to be the
 * wrong primitive: built-ins are resolved at MATCH time against the caller's language, so a
 * backfill freezes language-derived data into user config permanently and unrepairably.
 *
 * Two independent facts — "do I have custom words" and "is this command on" — so two fields.
 */
describe("a command can be switched off, without freezing its words (#443)", () => {
	const notMuted = { muted: false, canSwitch: false };
	const off = (...cmds: VoiceCommand[]) => ({ disabled: cmds });

	// The account that started #385, verbatim: an explicit stop-speech keyword and, now, exit off.
	it("disabling exit means 'stop' and 'stop stop' no longer tear hands-free down", () => {
		for (const said of ["stop", "stop stop", "exit voice", "back to text"]) {
			expect(matchVoiceCommand(said, off("exit"), "en", { muted: false }), said).not.toBe("exit");
			expect(splitTrailingCommand(said, off("exit"), "en", notMuted).command, said).not.toBe("exit");
		}
	});

	/**
	 * BOTH, not one. They already share `commandPhrases` so they cannot disagree about what a word
	 * MEANS; a disagreement about whether a command EXISTS is not a no-op either — the splitter
	 * would amputate the phrase off the end of a real message that the matcher had just declined
	 * to act on.
	 */
	it("a disabled command's phrase reaches the agent as ordinary speech instead of being amputated", () => {
		expect(splitTrailingCommand("run the tests, mute mic", off("mute"), "en", notMuted)).toEqual({
			command: null,
			text: "run the tests, mute mic",
		});
		// …and the same utterance with mute ON is still split, so the assertion is about the flag.
		expect(splitTrailingCommand("run the tests, mute mic", undefined, "en", notMuted)).toEqual({
			command: "mute",
			text: "run the tests",
		});
	});

	it("takes the repetition path with it, so no branch keeps a disabled command alive", () => {
		expect(matchVoiceCommand("mute mute mute", off("mute"), "en", { muted: false })).toBeNull();
		expect(splitTrailingCommand("push everything, mute mute", off("mute"), "en", notMuted)).toEqual({
			command: null,
			text: "push everything, mute mute",
		});
	});

	it("switches off exactly what it names and nothing else", () => {
		const w = off("exit");
		expect(matchVoiceCommand("mute", w, "en", { muted: false })).toBe("mute");
		expect(matchVoiceCommand("repeat", w, "en", { muted: false })).toBe("repeat");
		expect(matchVoiceCommand("unmute", w, "en", { muted: true })).toBe("unmute");
	});

	// The property the backfill would have destroyed, asserted directly.
	it("blank still means 'use ours', and ours still follow the configured language", () => {
		expect(commandPhrases("mute", undefined, "en")).toContain("mute");
		expect(commandPhrases("mute", undefined, "es")).toContain("silencio");
		expect(commandPhrases("mute", undefined, "zh")).toContain("静音");
		expect(matchVoiceCommand("silencio", undefined, "es", { muted: false })).toBe("mute");
		expect(matchVoiceCommand("静音", undefined, "zh", { muted: false })).toBe("mute");
	});

	it("an account that has configured nothing resolves exactly the phrases it always did", () => {
		for (const lang of ["en", "es", "fr", "de", "it", "pt", "zh", "ja", "ko", "hi"]) {
			for (const command of ALL_VOICE_COMMANDS) {
				expect(commandPhrases(command, { disabled: [] }, lang), `${lang}/${command}`).toEqual(
					commandPhrases(command, undefined, lang),
				);
			}
		}
	});

	// Turning a feature OFF must not hand your words to a different action: `exitWords: ["pardon"]`
	// stays inert rather than becoming the built-in `repeat` phrase it collides with.
	it("a disabled command keeps its reservations, so its words go quiet rather than change meaning", () => {
		expect(matchVoiceCommand("pardon", { exit: ["pardon"] }, "en", { muted: false })).toBe("exit");
		expect(matchVoiceCommand("pardon", { exit: ["pardon"], disabled: ["exit"] }, "en", { muted: false })).toBeNull();
	});

	// "Use suggested" fills a field from this function, so the panel and the matcher cannot show
	// different words. Disabled returns nothing, which is also what the panel greys out.
	it("offers the phrases the matcher would actually have used, for the current language", () => {
		expect(commandPhrases("exit", undefined, "de")).toContain("textmodus");
		expect(commandPhrases("exit", { disabled: ["exit"] }, "de")).toEqual([]);
	});
});

/**
 * #469 — every listener must see the SAME word set, or one phrase gets two meanings.
 *
 * `use-voice.ts` built this object five times by hand, and the control listener's copy — the one
 * running while the agent speaks or thinks, i.e. the only speech path live in that phase — omitted
 * `repeat`. The missing dispatch was harmless (that listener has no repeat branch). The missing
 * RESERVATION was not: `commandPhrases` strips from a command's built-ins every phrase the user
 * bound elsewhere, and it can only see the fields it is given.
 *
 * These are unit tests over the matcher because the divergence has to be caught where it does
 * damage — the shape of a literal in a hook is not the claim. The structural half (one object, one
 * construction site) lives in `use-voice-words.test.ts`.
 */
describe("a partial word set silently un-reserves a user's phrase (#469)", () => {
	// The worked example from the issue: Repeat bound to "stop", Exit left blank. "stop" is a
	// built-in ENGLISH exit phrase, so the two readings differ by exactly one field.
	const FULL = { repeat: ["stop"] };
	/** The control listener's set as it was — every field except the one the user actually used. */
	const CONTROL_LISTENER_AS_WAS = { mute: [], unmute: [], exit: [], next: [], scrap: [], stopSpeech: "", disabled: [] };

	it("reads the same transcript the same way with the full set and the control listener's", () => {
		// THE assertion. Not "the object has seven fields" — that passes while the two disagree.
		for (const said of ["stop", "mute", "unmute", "exit voice", "repeat", "say that again"]) {
			for (const muted of [false, true]) {
				expect(
					matchVoiceCommand(said, FULL, "en", { muted, canSwitch: true }),
					`"${said}" (muted=${muted}) means different things on different listeners`,
				).toBe(matchVoiceCommand(said, { ...CONTROL_LISTENER_AS_WAS, repeat: ["stop"] }, "en", { muted, canSwitch: true }));
			}
		}
	});

	it("does not tear hands-free down on a phrase the user bound to repeat", () => {
		// The damage, stated as the user experiences it. With `repeat` present the built-in exit
		// list gives "stop" up (#385 rule 2); without it, "stop" exits — while the agent is
		// speaking, which is exactly when you say "say that again".
		expect(commandPhrases("exit", FULL, "en")).not.toContain("stop");
		expect(matchVoiceCommand("stop", FULL, "en", { muted: false })).toBe("repeat");
		// The old control-listener set, for the record: the same word, the destructive reading.
		expect(matchVoiceCommand("stop", CONTROL_LISTENER_AS_WAS, "en", { muted: false })).toBe("exit");
	});

	it("carries it into the repetition fold, which must not reopen the collision", () => {
		// #456's fold is a FALLBACK reading and may never outrank a binding. "stop stop" bound to
		// repeat folds to "stop" — a built-in exit phrase — the moment `repeat` is invisible.
		const bound = { repeat: ["stop stop"] };
		expect(matchVoiceCommand("stop stop", bound, "en", { muted: false })).toBe("repeat");
		expect(splitTrailingCommand("stop stop", bound, "en", { muted: false, canSwitch: false }).command).not.toBe("exit");
	});

	it("changes nothing for an account with no custom repeat words — which is every account today", () => {
		for (const said of ["stop", "stop stop", "mute", "exit voice", "repeat", "pardon"]) {
			for (const muted of [false, true]) {
				expect(matchVoiceCommand(said, { repeat: [] }, "en", { muted, canSwitch: true }), said).toBe(
					matchVoiceCommand(said, CONTROL_LISTENER_AS_WAS, "en", { muted, canSwitch: true }),
				);
			}
		}
	});

	it("still returns nothing when the user switched repeat OFF (#443 keeps working through this)", () => {
		// "Off" was already honoured on this listener (`disabled` was passed); "rebound" was not.
		// Widening the set must not resurrect a command the user switched off.
		expect(matchVoiceCommand("stop", { repeat: ["stop"], disabled: ["repeat"] }, "en", { muted: false })).toBeNull();
		expect(commandPhrases("repeat", { repeat: ["stop"], disabled: ["repeat"] }, "en")).toEqual([]);
		// …and its reservation survives, so "stop" does not become exit instead (#443's own rule).
		expect(commandPhrases("exit", { repeat: ["stop"], disabled: ["repeat"] }, "en")).not.toContain("stop");
	});

	it("leaves mute reachable while the agent speaks, whatever the user bound repeat to (ADR 0001 M3)", () => {
		// The one thing widening this set could have cost: `matchVoiceCommand` checks repeat BEFORE
		// mute, so a repeat binding must never swallow a mute phrase. It cannot — an explicit
		// binding only ever REMOVES built-ins from other commands, and "mute" is not in it.
		expect(matchVoiceCommand("mute", FULL, "en", { muted: false })).toBe("mute");
		expect(matchVoiceCommand("mute mute", FULL, "en", { muted: false })).toBe("mute");
		expect(matchVoiceCommand("unmute", FULL, "en", { muted: true })).toBe("unmute");
	});
});

/**
 * #469, the case the guard above stops one step short of — and it is an ADR 0001 M1 violation that
 * ships today.
 *
 * The reasoning at `"leaves mute reachable … whatever the user bound repeat to"` is sound and its
 * assertions pass, but it rests on a premise that only holds while the two bindings are DIFFERENT:
 * *"an explicit binding only ever REMOVES built-ins from other commands, and 'mute' is not in it"*.
 * Nothing removes anything when the user puts the SAME phrase in both fields. `parseVoiceWords`
 * (`workers/api/src/lib/preferences.ts:287-289`) parses each command's list independently and there
 * is no cross-command dedup anywhere, so `{ repeat: ["quiet"], mute: ["quiet"] }` is a state a user
 * can save from the console today.
 *
 * `matchVoiceCommand` then checked `repeat` before `mute`, so that phrase resolved to `repeat` — and
 * the always-on control listener, the ONLY speech path live while the agent talks or thinks, has no
 * `repeat` branch. The word did **nothing** in three of the five phases ADR 0001 enumerates. Not
 * "repeat instead of mute": nothing at all, silently, in exactly the phases M1 names as the ones
 * that may never be dead zones.
 *
 * The order is now mute-first. It is observable ONLY here — the built-in phrase tables are pairwise
 * disjoint in every language (asserted below, with its denominator), so for every account that has
 * not double-bound a phrase the two orders are the same function.
 */
describe("a phrase bound to BOTH mute and repeat resolves to mute (#469, ADR 0001 M1)", () => {
	const BOTH = { repeat: ["quiet"], mute: ["quiet"] };

	it("gives the phrase to mute, in every phase the control listener carries", () => {
		// The control listener judges partials AND finals, and raises the bar to whole-utterance
		// while the agent's own voice may be in the mic (#386). Mute must survive all of it.
		for (const state of [{ muted: false }, { muted: false, whole: true }]) {
			expect(
				matchVoiceCommand("quiet", BOTH, "en", state),
				"a phrase the user bound to both is being read as repeat — mute has a dead zone while the agent speaks (ADR 0001 M1)",
			).toBe("mute");
		}
		// The doubled emphatic a user reaches for when the first attempt appeared not to work (#456).
		expect(matchVoiceCommand("quiet quiet", BOTH, "en", { muted: false })).toBe("mute");
	});

	it("still refuses repeat while muted, and still finds unmute there", () => {
		// The muted branch never checked repeat (speaking while the user asked for silence), so the
		// reorder must not have reached it.
		expect(matchVoiceCommand("quiet", BOTH, "en", { muted: true })).toBeNull();
		expect(matchVoiceCommand("unmute", BOTH, "en", { muted: true })).toBe("unmute");
	});

	it("leaves repeat alone when the user bound it to a phrase mute does not claim", () => {
		expect(matchVoiceCommand("stop", { repeat: ["stop"] }, "en", { muted: false })).toBe("repeat");
		expect(matchVoiceCommand("say that again", undefined, "en", { muted: false })).toBe("repeat");
	});

	/**
	 * WHY the reorder is safe, as an assertion rather than a paragraph — and with the size of what
	 * it examined, per ADR 0002. If any two commands shared a built-in phrase in any language, the
	 * order of the checks would decide that language's behaviour for every default account, and
	 * moving `mute` would be a silent behaviour change rather than a no-op.
	 */
	it("is a no-op for every account that has not double-bound a phrase — the built-in tables are pairwise disjoint", () => {
		const langs = ["en", "es", "fr", "de", "it", "pt", "ru", "zh", "ja", "ko", "ar", "hi", "nl", "pl", "tr", "sv", "uk", "vi", "id", "th"];
		let comparisons = 0;
		let phrases = 0;
		for (const lang of langs) {
			for (const a of ALL_VOICE_COMMANDS) {
				const left = commandPhrases(a, undefined, lang);
				phrases += left.length;
				for (const b of ALL_VOICE_COMMANDS) {
					if (a >= b) continue;
					comparisons += 1;
					const shared = commandPhrases(b, undefined, lang).filter((p) => left.includes(p));
					expect(shared, `${lang}: "${shared.join('", "')}" is a built-in phrase for both ${a} and ${b} — the matcher's ORDER now decides what it means`).toEqual([]);
				}
			}
		}
		// ADR 0002 — the denominator is the assertion. An empty command table, a `langKey` that
		// stopped resolving, or a `commandPhrases` that started returning [] would otherwise make
		// "no overlaps" true by measuring nothing.
		expect(comparisons).toBe((langs.length * ALL_VOICE_COMMANDS.length * (ALL_VOICE_COMMANDS.length - 1)) / 2);
		expect(comparisons).toBeGreaterThan(400);
		expect(phrases, "the phrase tables resolved to almost nothing — this test is comparing empty sets").toBeGreaterThan(400);
	});
});
