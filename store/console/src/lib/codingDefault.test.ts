import { describe, expect, it } from "vitest";
import { codingWriteBody, saveCodingEngine } from "./codingDefault";

describe("what a coding-engine choice sends (#1282)", () => {
	it("Platform default clears with an explicit null — `coding: {}` is rejected by the route", () => {
		expect(codingWriteBody("")).toEqual({ coding: { defaultEngineId: null } });
	});
	it("a concrete engine is sent as its id", () => {
		expect(codingWriteBody("codex")).toEqual({ coding: { defaultEngineId: "codex" } });
	});
});

describe("saveCodingEngine", () => {
	it("returns what the server now stores, so the page shows that and not what it asked for", async () => {
		expect(await saveCodingEngine(async () => ({ preferences: { coding: { defaultEngineId: "codex" } } }), "codex")).toEqual({ ok: true, persisted: "codex" });
		expect(await saveCodingEngine(async () => ({ preferences: { coding: {} } }), "")).toEqual({ ok: true, persisted: "" });
		// the server kept the old value: that is what comes back, not the request
		expect(await saveCodingEngine(async () => ({ preferences: { coding: { defaultEngineId: "claude" } } }), "codex")).toEqual({ ok: true, persisted: "claude" });
	});
	it("a refusal yields the reason and NO new value, so the control cannot adopt the attempted one", async () => {
		const r = await saveCodingEngine(async () => {
			throw new Error("coding.defaultEngineId must be an engine id");
		}, "");
		expect(r).toEqual({ ok: false, error: "coding.defaultEngineId must be an engine id" });
		expect(await saveCodingEngine(async () => Promise.reject("boom"), "codex")).toEqual({ ok: false, error: "Couldn't save that. Try again." });
	});
});
