/** #1357 — the structured error read from an engine's own turn-end event. Shapes below were captured from real CLIs. */
import { describe, expect, it } from "vitest";
import { kindOfStatus, statusFromErrorField, structuredTurnError } from "./engine-error.js";
import { turnReportFromTurnEnd } from "./engine-turn.js";

/** Claude Code 2.1.322, rejected key (captured). */
const CLAUDE_401 = { type: "result", is_error: true, subtype: "success", api_error_status: 401, api_error_origin: "first_party", terminal_reason: "api_error", result: "Invalid API key - Fix external API key" };

describe("kindOfStatus", () => {
	it("maps the statuses a run acts on and nothing else", () => {
		expect([401, 403].map(kindOfStatus)).toEqual(["auth", "auth"]);
		expect(kindOfStatus(402)).toBe("billing");
		expect(kindOfStatus(429)).toBe("limit");
		expect([408, 425, 500, 529, 599].map(kindOfStatus)).toEqual(Array(5).fill("transient"));
		expect([200, 400, 404, 409, 600].map(kindOfStatus)).toEqual(Array(5).fill(null));
	});
});

describe("structuredTurnError", () => {
	it("reads Claude's api_error_status from the captured result (subtype 'success' is not a signal)", () => {
		expect(structuredTurnError("claude", CLAUDE_401, true)).toEqual({ kind: "auth", provider: "anthropic (claude)", code: "401" });
		expect(structuredTurnError("claude", { ...CLAUDE_401, api_error_status: 429 }, true)).toMatchObject({ kind: "limit", code: "429" });
		expect(structuredTurnError("claude", { ...CLAUDE_401, api_error_status: 529 }, true)).toMatchObject({ kind: "transient" });
	});
	it("a turn that did not fail never carries one, whatever the event holds", () => {
		expect(structuredTurnError("claude", CLAUDE_401, false)).toBeUndefined();
	});
	it("says nothing for an unmapped status, a missing one, or non-object raw", () => {
		expect(structuredTurnError("claude", { ...CLAUDE_401, api_error_status: 400 }, true)).toBeUndefined();
		expect(structuredTurnError("claude", { type: "result", is_error: true }, true)).toBeUndefined();
		for (const raw of [null, undefined, "x", 3, []]) expect(structuredTurnError("claude", raw, true)).toBeUndefined();
	});
	it("Codex/Grok captured shapes carry only prose, so they report none (the cloud's text table covers them)", () => {
		expect(structuredTurnError("codex", { type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } }, true)).toBeUndefined();
		expect(structuredTurnError("grok", { type: "error", message: "Not signed in" }, true)).toBeUndefined();
	});
	it("an explicit numeric status on an error object is honoured for any engine, with a stated reset", () => {
		expect(structuredTurnError("codex", { type: "turn.failed", error: { message: "m", status: 429, resets_at: 1_800_000_000 } }, true)).toEqual({ kind: "limit", provider: "openai (codex)", code: "429", resetsAt: 1_800_000_000_000 });
	});
	it("never reads a status out of prose", () => {
		expect(statusFromErrorField({ message: "HTTP 429 too many" })).toBeNull();
		expect(statusFromErrorField({ status: "429" })).toBeNull();
		expect(statusFromErrorField({ status: 42 })).toBeNull();
		expect(statusFromErrorField({ status_code: 503 })).toBe(503);
	});
});

describe("turnReportFromTurnEnd", () => {
	it("puts the error on a failed report, and none on an ok one", () => {
		expect(turnReportFromTurnEnd("claude", CLAUDE_401, true, CLAUDE_401.result, 5).error).toEqual({ kind: "auth", provider: "anthropic (claude)", code: "401" });
		expect(turnReportFromTurnEnd("claude", CLAUDE_401, false, "", 5)).not.toHaveProperty("error");
		expect(turnReportFromTurnEnd("codex", { type: "turn.failed" }, true, "boom", 5)).not.toHaveProperty("error");
	});
});
