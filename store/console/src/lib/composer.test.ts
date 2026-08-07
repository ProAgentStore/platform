import { describe, expect, it } from "vitest";
import { composerPlaceholder, shouldShowComposer } from "./composer";

const state = (over: Partial<Parameters<typeof composerPlaceholder>[0]> = {}) =>
	composerPlaceholder({ talking: false, mode: "text", micOn: false, isCoding: false, isTmux: false, ...over });

describe("composerPlaceholder", () => {
	it("says how to send while a recording is open — in BOTH voice modes", () => {
		expect(state({ talking: true, mode: "ptt" })).toBe("Listening — tap to send");
		expect(state({ talking: true, mode: "handsfree", micOn: true })).toBe("Listening — tap to send");
	});

	// The ordering that a mode-first chain gets wrong: mid-sentence is not "just talk".
	it("does not fall back to the mode's idle prompt over a live recording", () => {
		expect(state({ talking: true, mode: "handsfree" })).not.toContain("just talk");
	});

	it("names the tap target in tap-to-talk, where nothing else does", () => {
		expect(state({ mode: "ptt" })).toBe("Use the voice control to talk — or type");
	});

	it("distinguishes a hands-free mic that is open from one between turns", () => {
		expect(state({ mode: "handsfree", micOn: true })).toBe("Listening…");
		expect(state({ mode: "handsfree", micOn: false })).toBe("Hands-free — just talk");
	});

	it("suggests what a typing user can ask THIS agent", () => {
		expect(state({ isCoding: true })).toBe("Ask about your repos...");
		expect(state({ isTmux: true })).toBe("Ask about tmux sessions...");
		expect(state()).toBe("Send a message...");
	});

	// A coding agent may also declare tmux; the repo prompt is the more useful of the two.
	it("prefers the repo prompt when an agent declares both", () => {
		expect(state({ isCoding: true, isTmux: true })).toBe("Ask about your repos...");
	});
});

const vis = (over: Partial<Parameters<typeof shouldShowComposer>[0]> = {}) =>
	shouldShowComposer({ mode: "text", draft: "", notice: "", ...over });

describe("shouldShowComposer", () => {
	it("is always on screen in text mode — that is the mode's whole point", () => {
		expect(vis()).toBe(true);
		expect(vis({ draft: "half a sentence" })).toBe(true);
	});

	it("is off screen in both voice modes while it holds nothing", () => {
		expect(vis({ mode: "ptt" })).toBe(false);
		expect(vis({ mode: "handsfree" })).toBe(false);
	});

	// The #175 contract: a turn classified `recover` is put in the box INSTEAD of being sent,
	// and that only ever happens in a voice mode. If the box cannot appear there, those words
	// are deleted at the instant they arrive.
	it("appears in a voice mode to hold a recovered turn", () => {
		expect(vis({ mode: "handsfree", draft: "did you get that last part" })).toBe(true);
		expect(vis({ mode: "ptt", draft: "did you get that last part" })).toBe(true);
	});

	// #364: with the box gone, a mic error or wrong-language warning has no surface at all.
	it("appears in a voice mode to carry the notice line", () => {
		expect(vis({ mode: "handsfree", notice: "Microphone blocked" })).toBe(true);
	});

	// Whitespace is not content — an empty box must not be held open by a stray newline.
	it("does not count whitespace as something worth showing", () => {
		expect(vis({ mode: "ptt", draft: "  \n " })).toBe(false);
		expect(vis({ mode: "ptt", notice: " " })).toBe(false);
	});

	// An unknown mode string is not text mode; it must not accidentally open an empty box.
	it("treats an unrecognised mode as a voice mode", () => {
		expect(vis({ mode: "something-new" })).toBe(false);
		expect(vis({ mode: "something-new", draft: "words" })).toBe(true);
	});
});
