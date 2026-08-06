import { describe, it, expect } from "vitest";
import { isEngineBusy, anyEngineBusy } from "./engine-busy.js";

describe("isEngineBusy", () => {
	it("is busy while thinking", () => {
		expect(isEngineBusy("thinking")).toBe(true);
	});

	it("is busy while responding — the state every call site used to miss", () => {
		// The engine streaming its answer is NOT finished. Treating it as idle made
		// watchForFinish summarize, and the Loop send its next instruction, mid-answer.
		expect(isEngineBusy("responding")).toBe(true);
	});

	it("still accepts the legacy 'working' alias", () => {
		expect(isEngineBusy("working")).toBe(true);
	});

	it("is not busy when idle", () => {
		expect(isEngineBusy("idle")).toBe(false);
	});

	it("is not busy for offline / unknown / missing states", () => {
		expect(isEngineBusy("offline")).toBe(false);
		expect(isEngineBusy("")).toBe(false);
		expect(isEngineBusy(undefined)).toBe(false);
		expect(isEngineBusy(null)).toBe(false);
	});
});

describe("anyEngineBusy", () => {
	it("reads the repoId → state map the repo list keeps", () => {
		expect(anyEngineBusy({ a: "idle", b: "responding" })).toBe(true);
		expect(anyEngineBusy({ a: "idle", b: "idle" })).toBe(false);
	});

	it("reads a plain list of states", () => {
		expect(anyEngineBusy(["idle", "thinking"])).toBe(true);
		expect(anyEngineBusy(["idle", "offline"])).toBe(false);
	});

	it("is not busy for empty or missing input", () => {
		expect(anyEngineBusy({})).toBe(false);
		expect(anyEngineBusy([])).toBe(false);
		expect(anyEngineBusy(null)).toBe(false);
		expect(anyEngineBusy(undefined)).toBe(false);
	});
});
