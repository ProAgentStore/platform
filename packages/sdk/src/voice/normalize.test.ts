import { describe, expect, it } from "vitest";
import { normalizeSpeech, trimTrailingPunctuation } from "./normalize.js";

describe("normalizeSpeech (#334 — one normaliser for every matcher)", () => {
	// THE incident. Whisper renders a repeated word as a hyphenated compound *sometimes*; the
	// owner's configured stop-word is "stop stop". All three renderings are the same utterance
	// and must normalise to the same string, or matching turns on punctuation nobody can see.
	it("renders 'Stop-stop.', 'Stop, stop.' and 'Stop stop.' identically", () => {
		expect(normalizeSpeech("Stop-stop.")).toBe("stop stop");
		expect(normalizeSpeech("Stop, stop.")).toBe("stop stop");
		expect(normalizeSpeech("Stop stop.")).toBe("stop stop");
	});

	// The class, not the character: an ASCII hyphen strip would have left every one of these.
	it("spaces EVERY dash — en, em, non-breaking, figure — not just ASCII hyphen-minus", () => {
		// U+002D hyphen-minus, U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
		// U+2013 en dash, U+2014 em dash. All `\p{Pd}`; an ASCII strip would have left five.
		for (const dash of ["-", "‐", "‑", "‒", "–", "—"]) {
			expect(normalizeSpeech(`stop${dash}stop`)).toBe("stop stop");
		}
	});

	it("spaces punctuation in any script, so a CJK or Spanish rendering matches too", () => {
		expect(normalizeSpeech("停止。")).toBe("停止");
		expect(normalizeSpeech("¿Para?")).toBe("para");
		expect(normalizeSpeech("「テキストモード」")).toBe("テキストモード");
	});

	// Apostrophes JOIN letters, so they are deleted rather than spaced — "don t" would match no
	// phrase list, and every list would otherwise have to carry both spellings.
	it("deletes elision marks so don't/dont and l'écoute/lécoute are one token", () => {
		expect(normalizeSpeech("Don't")).toBe("dont");
		expect(normalizeSpeech("dont")).toBe("dont");
		expect(normalizeSpeech("Don’t stop")).toBe("dont stop");
		expect(normalizeSpeech("reprends l'écoute")).toBe(normalizeSpeech("reprends l’écoute"));
	});

	it("deletes invisible format characters — a match must not turn on a glyph nobody can see", () => {
		expect(normalizeSpeech("stop­stop")).toBe("stopstop"); // soft hyphen: one word, hyphenated for display
		expect(normalizeSpeech("﻿text mode")).toBe("text mode");
	});

	it("normalises composed vs decomposed accents (engines disagree about which they emit)", () => {
		// Left: NFC (single code point). Right: NFD (letter + combining accent). Same spoken word.
		expect(normalizeSpeech("r\u00e9p\u00e8te")).toBe("r\u00e9p\u00e8te");
		expect(normalizeSpeech("re\u0301pe\u0300te")).toBe("r\u00e9p\u00e8te");
	});

	it("collapses whitespace of every kind and trims", () => {
		expect(normalizeSpeech("  text   mode  ")).toBe("text mode");
	});

	it("is total — empty, whitespace and punctuation-only inputs come back empty", () => {
		for (const junk of ["", "   ", "…", "—", "。、"]) expect(normalizeSpeech(junk)).toBe("");
	});
});

describe("trimTrailingPunctuation", () => {
	it("cuts trailing punctuation and space but leaves the words (and their casing) alone", () => {
		expect(trimTrailingPunctuation("Do it, copy.")).toBe("Do it, copy");
		expect(trimTrailingPunctuation("Stop-stop.")).toBe("Stop-stop");
		expect(trimTrailingPunctuation("run the tests, ")).toBe("run the tests");
	});
});
