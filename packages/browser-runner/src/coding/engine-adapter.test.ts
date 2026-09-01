import { describe, expect, it } from "vitest";
import { buildClaudeArgs, engineAdapterFor } from "./engine-adapter.js";

describe("engineAdapterFor", () => {
	it("keeps Claude on structured stream-json launch arguments", () => {
		const adapter = engineAdapterFor("claude");

		expect(adapter.mode).toBe("stream-json");
		expect(adapter.buildLaunchArgs(["--model", "sonnet", "--output-format", "text"], "sess-1")).toEqual([
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--model",
			"sonnet",
			"--dangerously-skip-permissions",
			"--resume",
			"sess-1",
		]);
	});

	it("leaves non-Claude engines as raw argv passthrough", () => {
		const adapter = engineAdapterFor("codex");
		const args = ["exec", "--sandbox", "danger-full-access"];

		expect(adapter.mode).toBe("raw");
		expect(adapter.buildLaunchArgs(args, "ignored-resume")).toEqual(args);
		expect(adapter.buildLaunchArgs(args, "ignored-resume")).not.toBe(args);
		expect(adapter.parseLine(JSON.stringify({ type: "result", result: "not parsed" }))).toEqual([]);
	});
});

describe("Claude engine adapter", () => {
	const adapter = engineAdapterFor("claude");

	it("normalizes stream-json lines into engine events", () => {
		expect(adapter.parseLine(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }))).toEqual([
			{ kind: "session", sessionId: "sess-1" },
		]);
		expect(
			adapter.parseLine(
				JSON.stringify({
					type: "assistant",
					message: { content: [{ type: "text", text: " hello " }, { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "git status" } }] },
				}),
			),
		).toEqual([
			{ kind: "assistant_text", text: "hello" },
			{ kind: "tool_use", block: { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "git status" } }, id: "tool-1", name: "Bash", input: { command: "git status" } },
		]);
		expect(adapter.parseLine(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] } }))).toEqual([
			{ kind: "tool_result", block: { type: "tool_result", tool_use_id: "tool-1", content: "ok" }, toolUseId: "tool-1", content: "ok" },
		]);
	});

	it("tolerates malformed and unknown lines", () => {
		expect(adapter.parseLine("{not-json")).toEqual([]);
		expect(adapter.parseLine(JSON.stringify({ type: "assistant", message: { content: ["bad", null] } }))).toEqual([]);
		expect(adapter.parseLine(JSON.stringify({ type: "other", message: { content: [{ type: "text", text: "ignored" }] } }))).toEqual([]);
	});
});

describe("buildClaudeArgs", () => {
	it("preserves repeated user flags while stripping structural ones", () => {
		expect(buildClaudeArgs(["--add-dir", "/a", "--add-dir", "/b", "--resume", "wrong"], null)).toEqual([
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--add-dir",
			"/a",
			"--add-dir",
			"/b",
			"--dangerously-skip-permissions",
		]);
	});
});
