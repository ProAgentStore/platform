import { describe, expect, it } from "vitest";
import { normalizeSpeech } from "./normalize-speech.js";
// The ORIGINAL, imported from the SDK's source. A test-only edge: `import-graph.test.ts` builds
// its graph from non-test files, `workers/api/tsconfig.json` excludes `*.test.ts`, and wrangler
// never sees this file — so nothing here puts the SDK into the deployed Worker or into the API's
// dependency graph. It exists purely so the two copies can be compared at runtime.
import { normalizeSpeech as sdkNormalizeSpeech } from "../../../../packages/sdk/src/voice/normalize.js";

/**
 * The vendored copy is only honest while it is asserted equal (#392).
 *
 * The bug this whole change exists to fix was two implementations of ONE rule drifting apart:
 * `resolveSubordinate` normalised a spoken agent name with `trim().toLowerCase()` while every
 * other spoken-text comparison went through the SDK's `normalizeSpeech`, so `"FAS platform."` —
 * a transcript with the trailing stop a transcriber routinely adds — was refused with "You do not
 * supervise \"FAS platform.\"".
 *
 * Vendoring the rule into `workers/api` (see that file's header for why a copy and not an import)
 * fixes the resolver and creates a SECOND opportunity for exactly the same drift. This file is
 * what closes it: it runs both implementations over the same inputs and requires identical
 * output, so editing one alone turns main red.
 *
 * Behavioural equality rather than a source-text comparison, deliberately. What matters is that
 * the two functions AGREE, not that they are spelled the same — a reformat, a renamed constant or
 * a different but equivalent regex should not fail, and a subtly different character class must.
 */

/** Everything the SDK's header names as a distinct class, plus the case from the issue. */
const CORPUS = [
	"",
	" ",
	"FAS platform.",
	"FAS platform",
	"fas-platform",
	"  FAS   platform  ",
	"Stop-stop.",
	"Stop, stop.",
	"stop stop",
	"don't stop",
	"don’t stop",
	"l'écoute",
	"l’écoute",
	"é",
	"é",
	"‍hidden‌",
	"soft­hyphen",
	"﻿bom",
	"en–dash em—dash ‑nb",
	"¿Cómo estás?",
	"停止。",
	"「引用」、テスト",
	"a.b.c",
	"...",
	"?!",
	"—",
	"(parens) [brackets] {braces}",
	"under_score",
	"tab\tand\nnewline",
	"MiXeD CaSe",
	"964594b6-4e1f-4c9a-9d3a-000000000000",
	"emoji 🚀 stays",
	"Привет, мир!",
	"مرحبا، بالعالم",
];

/**
 * A deterministic LCG, so a failure is reproducible and the suite never flakes. Random INPUT with
 * a fixed seed is what catches a character class the corpus author did not think of — which is
 * precisely how the two SDK normalisers diverged in #334 (one stripped hyphens, one did not).
 */
function seededStrings(seed: number, count: number, maxLen: number): string[] {
	let state = seed;
	const next = () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
	const pool = [
		..."abzAZ09 \t\n",
		..."-–—‑_.,!?;:'’‘`´ʻʼ\"“”()[]{}/\\@#*&",
		..."。、！？「」《》¡¿",
		..."éeÉ́åöñ",
		..."абвЯ",
		..."中文日本語",
		"​",
		"‌",
		"‍",
		"­",
		"﻿",
		"🚀",
	];
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		const len = Math.floor(next() * (maxLen + 1));
		let s = "";
		for (let j = 0; j < len; j++) s += pool[Math.floor(next() * pool.length)];
		out.push(s);
	}
	return out;
}

describe("the vendored normaliser is the SDK's, asserted rather than assumed (#392)", () => {
	it("agrees with the SDK on every class the rule distinguishes", () => {
		for (const input of CORPUS) {
			expect(normalizeSpeech(input), JSON.stringify(input)).toBe(sdkNormalizeSpeech(input));
		}
	});

	it("agrees with the SDK on 2000 seeded random strings", () => {
		for (const input of seededStrings(0x392, 2000, 14)) {
			expect(normalizeSpeech(input), JSON.stringify(input)).toBe(sdkNormalizeSpeech(input));
		}
	});

	it("still does the four things the resolver depends on", () => {
		// Stated here as well as asserted equal, because "equal to the SDK" is only useful if the
		// SDK's behaviour is the one `resolveSubordinate` was fixed to rely on.
		expect(normalizeSpeech("FAS platform.")).toBe("fas platform");
		expect(normalizeSpeech("FAS-platform")).toBe("fas platform");
		expect(normalizeSpeech("don’t")).toBe("dont");
		expect(normalizeSpeech("a‍b")).toBe("ab");
	});

	it("returns the empty string for input that is only punctuation", () => {
		// The property `resolveSubordinate` guards on: `"".startsWith("")` is true of every row, so
		// an all-punctuation query must be caught before it reaches the fuzzy arm.
		for (const junk of ["", "  ", ".", "…", "?!", "—", "。", "‍"]) {
			expect(normalizeSpeech(junk), JSON.stringify(junk)).toBe("");
		}
	});
});
