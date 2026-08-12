import { describe, expect, it } from "vitest";
import { RESOURCE_MAX_CHARS } from "./connectors/mcp.js";
import { capToolResult, TOOL_LOG_FAILURE_MAX_CHARS, TOOL_LOG_MAX_CHARS, TOOL_RESULT_MAX_CHARS, toolLogLine } from "./tool-result-cap.js";

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

/**
 * The capability-constraint refusal exactly as `runRegistryTool` composes it (tool-registry.ts),
 * for `tmux_list_sessions` on the `tmux` connector — the string the reported turn actually produced.
 * Copied rather than imported because it is built inline at the refusal site; if the wording there
 * changes, re-measure it here, since the whole point of the number below is that it covers this.
 */
const TMUX_CONSTRAINT_REFUSAL =
	'This agent\'s declared constraints for the tmux connector could not be resolved — this call names no subscribed instance for them to belong to — so "tmux_list_sessions" was refused rather than run unconstrained. A ceiling is resolved per instance (the creator\'s declaration, narrowed by that instance\'s own binding), so run this from a subscribed instance rather than from a template preview or trial chat.';

describe("toolLogLine (#517) — a FAILED tool result reaches the owner whole", () => {
	it("shows the refusal's remedy clause, which the flat 120 cut off", () => {
		// The reported defect, stated as the thing the owner could and could not read. At 120 the pill
		// ended four characters into "instance" — the word that begins the remedy — so the console
		// showed a wrong fix from the model and the right one nowhere.
		expect(TMUX_CONSTRAINT_REFUSAL.slice(0, TOOL_LOG_MAX_CHARS)).not.toContain("run this from a subscribed instance");
		const line = toolLogLine("tmux_list_sessions", TMUX_CONSTRAINT_REFUSAL, false);
		expect(line).toContain("run this from a subscribed instance rather than from a template preview or trial chat.");
		expect(line.startsWith("❌ **tmux_list_sessions** ")).toBe(true);
	});

	it("bounds a failure nobody authored, and marks the cut", () => {
		// The only long failure text is the passthrough at tool-registry's outer catch, which can
		// carry an upstream body. Visible truncation, because the sentence being cut is an
		// instruction — a silently truncated instruction is how this started.
		const upstream = `Error: ${"z".repeat(2_000)}`;
		const line = toolLogLine("http_request", upstream, false);
		expect(line.length).toBeLessThanOrEqual(TOOL_LOG_FAILURE_MAX_CHARS + 40);
		expect(line.endsWith("…")).toBe(true);
	});

	it("every platform-authored refusal fits, so the budget is a backstop and not a cut", () => {
		expect(TMUX_CONSTRAINT_REFUSAL.length).toBeLessThanOrEqual(TOOL_LOG_FAILURE_MAX_CHARS);
	});

	it("leaves a SUCCESS pill byte-identical to what it was", () => {
		// #517's acceptance criteria: no change to any successful tool call's transcript. A success
		// pill is a preview of DATA and the answer above it carries the meaning — so it keeps the old
		// number and, deliberately, the old absence of an ellipsis.
		const data = "a".repeat(400);
		expect(toolLogLine("tmux_capture_pane", data, true)).toBe(`✅ **tmux_capture_pane** ${data.slice(0, 120)}`);
		expect(toolLogLine("create_task", "done", true)).toBe("✅ **create_task** done");
	});

	it("survives a non-string result without throwing", () => {
		expect(toolLogLine("x", undefined as unknown as string, false)).toBe("❌ **x** ");
	});
});
