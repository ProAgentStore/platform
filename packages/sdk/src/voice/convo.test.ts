import { describe, expect, it } from "vitest";
import { decideRestart, matchVoiceCommand, resolveVoiceMode, resolveVoiceStatus } from "./convo.js";

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
});
