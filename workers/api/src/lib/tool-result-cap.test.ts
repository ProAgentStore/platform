import { describe, expect, it } from "vitest";
import { RESOURCE_MAX_CHARS } from "./connectors/mcp.js";
import { capToolResult, TOOL_RESULT_MAX_CHARS } from "./tool-result-cap.js";

describe("capToolResult (#427 item 3)", () => {
	it("leaves an ordinary result completely alone", () => {
		// The overwhelming majority of results. A cap that rewrites the common case is a cap that
		// changes behaviour it was never asked to change.
		const content = '{"number":111,"title":"Feature: Masters Games Training section"}';
		expect(capToolResult(content)).toBe(content);
		expect(capToolResult("")).toBe("");
	});

	it("keeps the head and says how much was dropped, with both numbers", () => {
		const huge = "x".repeat(TOOL_RESULT_MAX_CHARS + 67_000);
		const capped = capToolResult(huge);
		expect(capped.startsWith("x".repeat(TOOL_RESULT_MAX_CHARS))).toBe(true);
		// Both numbers, because "truncated" alone leaves the model unable to tell whether it lost a
		// sentence or 90% of the document — and it guesses generously.
		expect(capped).toContain(huge.length.toLocaleString("en-US"));
		expect(capped).toContain(TOOL_RESULT_MAX_CHARS.toLocaleString("en-US"));
	});

	it("tells the model to ask for a narrower slice rather than answer from the fragment", () => {
		// #427's stated regression risk: a cap can hide what the model needed. The mitigation is that
		// the model is told, in the result itself, that there is more and how to get it.
		const capped = capToolResult("y".repeat(TOOL_RESULT_MAX_CHARS + 1));
		expect(capped).toMatch(/NOT read/);
		expect(capped).toMatch(/narrower slice/);
	});

	it("sits above every deliberate per-tool cap, so it can only fire on an unbounded one", () => {
		// The invariant that keeps this a BACKSTOP. `RESOURCE_MAX_CHARS` (20,000) is the largest cap
		// any tool chooses for itself; a ceiling below it would silently overrule a judgement someone
		// made on purpose, which is a worse bug than the one this prevents. The other deliberate caps
		// — github_read_issue 8KB, repo_read_file 8KB, repo_git 12KB, fetch_url 4,000 — are smaller
		// still.
		expect(TOOL_RESULT_MAX_CHARS).toBeGreaterThan(RESOURCE_MAX_CHARS);
	});

	it("survives a non-string result without throwing", () => {
		expect(capToolResult(undefined as unknown as string)).toBe("");
	});
});
