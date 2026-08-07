import { describe, expect, it } from "vitest";
import { composerPlaceholder } from "./composer";

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
