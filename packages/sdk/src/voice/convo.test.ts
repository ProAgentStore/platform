import { describe, expect, it } from "vitest";
import { decideRestart, matchVoiceCommand, resolveVoiceMode } from "./convo.js";

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
