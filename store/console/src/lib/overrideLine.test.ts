import { describe, expect, it } from "vitest";
import { overrideLineText, overrideState } from "./overrideLine";

describe("overrideState: the six states (#1599)", () => {
	it("loading: the fetch has not landed", () => {
		expect(overrideState({ load: "loading", hasOverride: false, revealed: false })).toBe("loading");
		expect(overrideState({ load: "loading", hasOverride: true, revealed: true })).toBe("loading");
	});
	it("failed: the fetch failed, whatever the local flags say", () => {
		expect(overrideState({ load: "failed", hasOverride: false, revealed: false })).toBe("failed");
		expect(overrideState({ load: "failed", hasOverride: false, revealed: true })).toBe("failed");
	});
	it("line: no override, not revealed", () => {
		expect(overrideState({ load: "loaded", hasOverride: false, revealed: false })).toBe("line");
	});
	it("revealed: no override yet, form open with Cancel", () => {
		expect(overrideState({ load: "loaded", hasOverride: false, revealed: true })).toBe("revealed");
	});
	it("overridden: a server override shows its form, revealed or not", () => {
		expect(overrideState({ load: "loaded", hasOverride: true, revealed: false })).toBe("overridden");
		expect(overrideState({ load: "loaded", hasOverride: true, revealed: true })).toBe("overridden");
	});
	it("cleared: overridden, then hasOverride false with revealed reset, is the line again", () => {
		const before = overrideState({ load: "loaded", hasOverride: true, revealed: true });
		const after = overrideState({ load: "loaded", hasOverride: false, revealed: false });
		expect([before, after]).toEqual(["overridden", "line"]);
	});
});

describe("overrideLineText", () => {
	it("never says 'follows your account' before it loaded", () => {
		expect(overrideLineText("Voice", "loading", "x")).toBe("Voice: Checking…");
		expect(overrideLineText("Translation", "failed", "x")).toBe("Translation: Couldn't check");
	});
	it("names the effective value once loaded", () => {
		expect(overrideLineText("Translation", "line", "off")).toBe("Translation: follows your account (off)");
	});
});
