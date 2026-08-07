import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { matchVoiceCommand, splitTrailingCommand, stripStopWord, type VoiceCommandWords } from "./convo.js";
import { type FinalizedTurn, planFinalizedTurn, planNoiseRejection, planSend, utteranceSoFar } from "./turn.js";

describe("utteranceSoFar", () => {
	it("prepends the accumulated buffer in hands-free browser dictation", () => {
		expect(utteranceSoFar({ pending: "run the", text: "tests", handsFree: true, isWhisper: false })).toBe("run the tests");
	});

	it("IGNORES the buffer in Whisper mode — the transcript is already the whole turn", () => {
		// The clip is uploaded once and comes back complete. Prepending a buffer that the
		// Whisper path never clears would say the first half of the turn twice.
		expect(utteranceSoFar({ pending: "run the", text: "run the tests", handsFree: true, isWhisper: true })).toBe("run the tests");
	});

	it("ignores the buffer outside hands-free — push-to-talk accumulates nothing", () => {
		expect(utteranceSoFar({ pending: "stale", text: "hello", handsFree: false, isWhisper: false })).toBe("hello");
	});

	it("is exactly the fragment when the buffer is empty, with no leading space", () => {
		expect(utteranceSoFar({ pending: "", text: "hello", handsFree: true, isWhisper: false })).toBe("hello");
		expect(utteranceSoFar({ pending: "  ", text: " hello ", handsFree: true, isWhisper: false })).toBe("hello");
	});

	it("is empty when nothing has been said, so a caller can test it as a truthy guard", () => {
		expect(utteranceSoFar({ pending: "", text: "   ", handsFree: true, isWhisper: false })).toBe("");
	});
});

describe("planFinalizedTurn", () => {
	const base = { commandsEnabled: true, canScrap: true, canSwitch: true, muted: false, lang: "en-US" as string | undefined, stopWords: [] as string[] };

	it("stages a scrap when the whole turn is the phrase", () => {
		expect(planFinalizedTurn("scrap that", base)).toEqual({ action: "scrap" });
	});

	it("judges scrap BEFORE the splitter — the sentence is not truncated into a delete", () => {
		// The failure this ordering prevents: the splitter keeps "let's rewrite the parser" and
		// the delete fires too, so the user loses the previous exchange AND sends a fragment.
		expect(planFinalizedTurn("let's rewrite the parser, scrap that", base)).toEqual({
			action: "send",
			text: "let's rewrite the parser, scrap that",
			command: null,
			switchAfter: false,
		});
	});

	it("leaves 'scrap that' as an ORDINARY MESSAGE when the consumer cannot delete", () => {
		// The Coder's Co-pilot has no delete path, so the words must reach the agent as speech.
		expect(planFinalizedTurn("scrap that", { ...base, canScrap: false })).toEqual({
			action: "send",
			text: "scrap that",
			command: null,
			switchAfter: false,
		});
	});

	it("never scraps while muted — a muted user's only commands are unmute/exit/next", () => {
		expect(planFinalizedTurn("scrap that", { ...base, muted: true }).action).not.toBe("scrap");
	});

	it("consumes the turn for 'repeat' — sending first would replace the reply being asked for", () => {
		expect(planFinalizedTurn("say that again", base)).toEqual({ action: "repeat" });
	});

	it("sends the message AND applies the trailing command ('run the tests, mute')", () => {
		expect(planFinalizedTurn("run the tests, mute mic", base)).toEqual({
			action: "send",
			text: "run the tests",
			command: "mute",
			switchAfter: false,
		});
	});

	it("sends nothing but still applies the command when the turn WAS the command", () => {
		expect(planFinalizedTurn("mute", base)).toEqual({ action: "none", command: "mute", switchAfter: false });
	});

	it("carries the departure separately from the command, so the message can go first", () => {
		expect(planFinalizedTurn("next", base)).toEqual({ action: "none", command: null, switchAfter: true });
	});

	it("does not leave when the consumer has nowhere to go", () => {
		expect(planFinalizedTurn("next", { ...base, canSwitch: false })).toEqual({
			action: "send",
			text: "next",
			command: null,
			switchAfter: false,
		});
	});

	it("strips a trailing stop-word from what survives the command split", () => {
		expect(planFinalizedTurn("run the tests copy", { ...base, stopWords: ["copy"] })).toEqual({
			action: "send",
			text: "run the tests",
			command: null,
			switchAfter: false,
		});
	});

	it("a stop-word alone leaves nothing to send", () => {
		expect(planFinalizedTurn("copy", { ...base, stopWords: ["copy"] })).toEqual({ action: "none", command: null, switchAfter: false });
	});

	it("with commands off, every command phrase is just a message", () => {
		const off = { ...base, commandsEnabled: false };
		for (const phrase of ["scrap that", "mute", "next", "say that again"]) {
			expect(planFinalizedTurn(phrase, off)).toEqual({ action: "send", text: phrase, command: null, switchAfter: false });
		}
	});

	it("never sends whitespace — an empty turn says 'none' rather than emitting ''", () => {
		expect(planFinalizedTurn("   ", base)).toEqual({ action: "none", command: null, switchAfter: false });
	});
});

/**
 * The extraction is only worth anything if it did not change what a turn DOES. This is the
 * inline chain as `use-voice.ts` carried it, transcribed verbatim, run against the same corpus.
 * It is a scaffold for THIS commit, not a second implementation to maintain — but while it is
 * here it also pins the two orderings (scrap before the splitter, stop-word after it) against
 * anyone tidying the extracted version.
 */
function legacyFinalize(
	msg: string,
	cfg: { commandsEnabled: boolean; canScrap: boolean; canSwitch: boolean; muted: boolean; words?: VoiceCommandWords; lang?: string; stopWords?: string[] },
): FinalizedTurn {
	if (cfg.commandsEnabled && cfg.canScrap && matchVoiceCommand(msg, cfg.words, cfg.lang, { muted: cfg.muted, canScrap: true }) === "scrap") {
		return { action: "scrap" };
	}
	let body = msg;
	let command: "mute" | "unmute" | "exit" | null = null;
	let switchAfter = false;
	if (cfg.commandsEnabled) {
		const split = splitTrailingCommand(msg, cfg.words, cfg.lang, { muted: cfg.muted, canSwitch: cfg.canSwitch });
		body = split.text;
		if (split.command === "repeat") return { action: "repeat" };
		if (split.command === "mute") command = "mute";
		else if (split.command === "unmute") command = "unmute";
		else if (split.command === "exit") command = "exit";
		else if (split.command === "next") switchAfter = true;
	}
	const t = stripStopWord(body, cfg.stopWords).text.trim();
	return t ? { action: "send", text: t, command, switchAfter } : { action: "none", command, switchAfter };
}

describe("planFinalizedTurn matches the inline chain it replaced", () => {
	const utterances = [
		"",
		"   ",
		"run the tests",
		"scrap that",
		"scrap that.",
		"Scrap that!",
		"scrap that idea and let's move on",
		"let's rewrite the parser, scrap that",
		"don't scrap that, keep it",
		"mute",
		"mute mute",
		"run the tests, mute mic",
		"unmute",
		"turn the mic back on",
		"exit voice",
		"run the tests, exit voice",
		"next",
		"check the logs, next agent",
		"repeat",
		"say that again",
		"what's next?",
		"don't forget to mute",
		"copy",
		"run the tests copy",
		"stop listening",
		"重复",
	];
	const flagMatrix = [true, false];

	it("agrees on every utterance × flag combination × stop-word setting", () => {
		let compared = 0;
		for (const msg of utterances) {
			for (const commandsEnabled of flagMatrix) {
				for (const canScrap of flagMatrix) {
					for (const canSwitch of flagMatrix) {
						for (const muted of flagMatrix) {
							for (const stopWords of [[], ["copy"], ["over and out"]]) {
								const cfg = { commandsEnabled, canScrap, canSwitch, muted, lang: "en-US", stopWords };
								expect(planFinalizedTurn(msg, cfg), `${JSON.stringify({ msg, ...cfg })}`).toEqual(legacyFinalize(msg, cfg));
								compared++;
							}
						}
					}
				}
			}
		}
		expect(compared).toBe(utterances.length * 2 * 2 * 2 * 2 * 3);
	});

	it("agrees when custom command words replace the built-ins", () => {
		const words: VoiceCommandWords = { scrap: ["bin it"], mute: ["hush now"], next: ["move along"] };
		for (const msg of ["bin it", "bin it please", "hush now", "run the tests, hush now", "move along"]) {
			const cfg = { commandsEnabled: true, canScrap: true, canSwitch: true, muted: false, words, lang: "en-US", stopWords: [] };
			expect(planFinalizedTurn(msg, cfg), msg).toEqual(legacyFinalize(msg, cfg));
		}
	});
});

describe("planSend", () => {
	const base = { heard: "", transcribePrompt: undefined as string | undefined, confirmLanguage: true, lang: "en-US", audioBytes: 0, instanceId: "inst-1" as string | undefined };

	it("drops a noise transcript", () => {
		expect(planSend("Thank you.", base)).toEqual({ action: "drop", reason: "noise" });
	});

	it("checks noise BEFORE language, so silence never earns a 'say that again' nudge", () => {
		// "you" is filler AND would read as a language mismatch under a non-Latin setting. The
		// user did not take a turn; telling them their language wasn't understood invents one.
		expect(planSend("you", { ...base, lang: "zh-CN" })).toEqual({ action: "drop", reason: "noise" });
	});

	it("drops a transcript in a language the user did not choose", () => {
		expect(planSend("这是一个测试句子", base)).toEqual({ action: "drop", reason: "language" });
	});

	it("does not police language when the lock is off", () => {
		expect(planSend("这是一个测试句子", { ...base, confirmLanguage: false }).action).toBe("send");
	});

	it("attaches audio only when there are BYTES", () => {
		// A zero-byte blob still minted an audio key, whose upload answers 400 and whose replay
		// answers 404 — a turn that looks replayable and is not.
		expect(planSend("run the tests", { ...base, audioBytes: 0 })).toMatchObject({ attachAudio: false });
		expect(planSend("run the tests", { ...base, audioBytes: 1 })).toMatchObject({ attachAudio: true });
	});

	it("attaches audio only when there is an instance to store it against", () => {
		expect(planSend("run the tests", { ...base, audioBytes: 4096, instanceId: undefined })).toMatchObject({ attachAudio: false });
	});

	it("carries the live capture beside the transcript when the two differ", () => {
		const plan = planSend("run the tests", { ...base, heard: "run the tests on the parser and then" });
		expect(plan).toMatchObject({ action: "send", text: "run the tests" });
		expect(plan.action === "send" && plan.dictation).toBeTruthy();
	});

	it("carries no capture when there is nothing to compare", () => {
		expect(planSend("run the tests", base)).toMatchObject({ dictation: undefined });
	});

	// #373. LAST, and only on a transcript that already survived both gates.
	it("applies the user's vocabulary to what is sent, and reports what it changed", () => {
		const plan = planSend("deploy heartful now", { ...base, vocabulary: ["HeartFull"] });
		expect(plan).toMatchObject({ action: "send", text: "deploy HeartFull now" });
	});

	it("runs the vocabulary AFTER the noise gate, never before it", () => {
		// Ordering it first would let a correction turn a near-miss INTO an exact bias term and get
		// the turn dropped as an echo (#332). A rewrite that swallows a message is strictly worse
		// than the mishearing it was trying to fix.
		const prompt = "Coder Lead";
		expect(planSend("Coder Leed", { ...base, transcribePrompt: prompt, vocabulary: ["Coder Lead"] })).toMatchObject({
			action: "send",
		});
	});

	it("compares the live capture against the CORRECTED text", () => {
		// Otherwise a turn whose only difference from the capture was a spelling fix keeps a
		// "what was heard" toggle that shows the same sentence twice.
		const plan = planSend("heartful", { ...base, heard: "HeartFull", vocabulary: ["HeartFull"] });
		expect(plan).toMatchObject({ text: "HeartFull", dictation: undefined });
	});

	it("changes nothing when no vocabulary is configured", () => {
		expect(planSend("run the tests", base)).toMatchObject({ text: "run the tests", corrections: [] });
	});
});

describe("planNoiseRejection", () => {
	const heardIt = { isAlive: true, heardSpeech: true };
	const heardNothing = { isAlive: true, heardSpeech: false };

	it("passes anything that is not noise, whatever the gate says", () => {
		for (const gate of [heardIt, heardNothing, null, undefined]) {
			expect(planNoiseRejection("run the tests", { gate })).toEqual({ action: "pass" });
		}
	});

	it("KEEPS the words when the gate heard real speech this turn", () => {
		// #377: the transcript is junk, but the user did speak — the transcriber failed to render
		// it. Clearing the turn here took the bubble and the live capture with it, so the words the
		// user watched appear a second earlier were gone with no record that a turn happened.
		const v = planNoiseRejection("Thank you.", { gate: heardIt });
		expect(v.action).toBe("keep");
		expect(v.action === "keep" && v.note).toBeTruthy();
	});

	it("discards silently when a live gate heard nothing — it really was noise", () => {
		expect(planNoiseRejection("Thank you.", { gate: heardNothing }).action).toBe("discard");
	});

	it("discards when there is no gate, or one that never ran", () => {
		// Same trust rule as endOfTurnAction — but the DEFAULT is the opposite way round on purpose:
		// where there is no gate (iOS, browser-dictation mode) there is no live capture either, so
		// "keeping the words" would put an empty "(nothing was captured)" bubble on screen.
		expect(planNoiseRejection("you", { gate: null }).action).toBe("discard");
		expect(planNoiseRejection("you", {}).action).toBe("discard");
		expect(planNoiseRejection("you", { gate: { isAlive: false, heardSpeech: true } }).action).toBe("discard");
	});

	it("keeps a turn rejected as a bias echo when the gate vouched for it", () => {
		// The #332 guard is unchanged — the transcript is still not sent. But `acceptSpeech` already
		// stops the gate vouching for the agent's own voice, so a gate that DID vouch means a human
		// spoke and the clip came back as our own vocabulary anyway.
		expect(planNoiseRejection("Coder Lead", { transcribePrompt: "Coder Lead", gate: heardIt }).action).toBe("keep");
		expect(planNoiseRejection("Coder Lead", { transcribePrompt: "Coder Lead", gate: heardNothing }).action).toBe("discard");
	});

	it("reports BOTH rejections, with a fixed message so a burst de-dups", () => {
		// A silent discard is why the report behind #377 could not be confirmed from the data: there
		// was nothing in the trace or the error log for a turn that never became a message.
		const kept = planNoiseRejection("Thank you.", { gate: heardIt });
		const dropped = planNoiseRejection("Thank you.", { gate: heardNothing });
		expect(kept.action === "keep" && kept.report).toMatch(/noise/);
		expect(dropped.action === "discard" && dropped.report).toMatch(/noise/);
		// reportClientError de-dups on source+message, so what differs per turn must NOT be in it.
		expect(planNoiseRejection("uh", { gate: heardNothing })).toEqual(dropped);
	});
});

/**
 * The interim/final distinction (#342), pinned as a COUNT rather than a comment.
 *
 * Three matcher call sites judge partial transcripts and two judge finished turns. A partial of
 * "scrap that idea and let's move on" is momentarily exactly "scrap that", so the destructive
 * command must only ever be judged where the whole utterance is whole. Every site now states
 * which kind it holds and `commandStateFor` drops the flag for the partials — this asserts that
 * no site went back to hand-building the matcher state, which is how the distinction would be
 * collapsed by someone "fixing" an inconsistency between them.
 */
describe("command matcher call sites", () => {
	const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf-8");
	const sources = { "use-voice.ts": read("./use-voice.ts"), "turn.ts": read("./turn.ts") };

	it("routes every matchVoiceCommand call through commandStateFor", () => {
		for (const [name, src] of Object.entries(sources)) {
			const calls = src.match(/matchVoiceCommand\(/g)?.length ?? 0;
			const gated = src.match(/commandStateFor\(/g)?.length ?? 0;
			expect(gated, `${name}: every matcher site must declare its transcript kind`).toBe(calls);
		}
	});

	/**
	 * Four sites hold ONE kind and say so as a literal. The fifth — the always-on control listener
	 * — holds whichever kind the recognizer just handed it, and since #386 that difference decides
	 * whether the transcript may be judged at all while the agent is speaking. It is the one site
	 * that must pass the kind through rather than name it, so it is pinned separately instead of
	 * being allowed to vanish from the count.
	 */
	it("keeps two partial sites, two final ones, and one that passes the kind through", () => {
		const all = Object.values(sources).join("\n");
		expect(all.match(/commandStateFor\("partial"/g)?.length, "the gate, the interim keyword path").toBe(2);
		expect(all.match(/commandStateFor\("final"/g)?.length, "the finished hands-free turn, the push-to-talk final").toBe(2);
		expect(all.match(/commandStateFor\(isFinal \? "final" : "partial"/g)?.length, "the always-on control listener").toBe(1);
	});

	/**
	 * The same shape of guard for the same shape of bug (#377). Three sites in the hook called
	 * `isNoiseTranscript` directly and read a `true` as "nothing was said" — so a turn the gate had
	 * heard was cleared, live capture and all, with nothing written anywhere. What a rejection
	 * COSTS is now one decision, and it is also what decides whether the loss is logged; a site
	 * that goes back to the raw predicate would reintroduce the erasure quietly.
	 */
	it("makes no noise decision in the hook without planNoiseRejection", () => {
		expect(sources["use-voice.ts"].match(/isNoiseTranscript\(/g)?.length ?? 0).toBe(0);
	});
});
