import { readFileSync } from "node:fs";
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

	it("leaves generic non-structured engines as raw argv passthrough", () => {
		const adapter = engineAdapterFor("gemini");
		const args = ["exec", "--sandbox", "danger-full-access"];

		expect(adapter.mode).toBe("raw");
		expect(adapter.buildLaunchArgs(args, "ignored-resume")).toEqual(args);
		expect(adapter.buildLaunchArgs(args, "ignored-resume")).not.toBe(args);
		expect(adapter.parseLine(JSON.stringify({ type: "result", result: "not parsed" }))).toEqual([]);
	});

	it("uses structured JSON for codex exec, and leaves bare codex raw", () => {
		expect(engineAdapterFor("codex").mode).toBe("raw");
		expect(engineAdapterFor("codex", ["exec", "resume", "thread-1"]).mode).toBe("raw");

		const adapter = engineAdapterFor("codex", ["exec", "--sandbox", "danger-full-access"]);
		expect(adapter.mode).toBe("stream-json");
		expect(adapter.persistent).toBe(false);
		expect(adapter.buildTurnArgs(["exec", "--sandbox", "danger-full-access"], "fix it")).toEqual([
			"exec",
			"--json",
			"--sandbox",
			"danger-full-access",
			"fix it",
		]);
		expect(adapter.buildTurnArgs(["exec", "--json", "--sandbox", "danger-full-access"], "fix it").filter((a) => a === "--json")).toHaveLength(1);
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

describe("Codex engine adapter", () => {
	const adapter = engineAdapterFor("codex", ["exec", "--sandbox", "danger-full-access"]);

	function parsedFixture(name: string) {
		const text = readFileSync(new URL(`./fixtures/codex-json-0.151.0/${name}.combined-output.txt`, import.meta.url), "utf8");
		return text.split("\n").flatMap((line) => adapter.parseLine(line));
	}

	it("normalizes the observed codex exec --json command-success fixture", () => {
		const events = parsedFixture("command-success");

		expect(events[0]).toEqual({ kind: "session", sessionId: "01a05aa7-ffc9-73f0-9ae8-02f96c418dc5" });
		expect(events).toContainEqual({
			kind: "tool_use",
			block: {
				type: "tool_use",
				id: "item_1",
				name: "Bash",
				input: { command: "/bin/zsh -lc \"sed -n '1,\"'$p'\"' note.txt\"" },
			},
			id: "item_1",
			name: "Bash",
			input: { command: "/bin/zsh -lc \"sed -n '1,\"'$p'\"' note.txt\"" },
		});
		expect(events).toContainEqual({
			kind: "tool_result",
			block: { type: "tool_result", tool_use_id: "item_1", is_error: false, content: "alpha-spike\n" },
			toolUseId: "item_1",
			content: "alpha-spike\n",
		});
		expect(events).toContainEqual({ kind: "assistant_text", text: "NOTE=alpha-spike" });
		expect(events.at(-1)).toMatchObject({ kind: "turn_end", isError: false });
	});

	it("normalizes failed codex command executions as failed tool results", () => {
		const events = parsedFixture("command-failure");

		expect(events).toContainEqual({
			kind: "tool_result",
			block: { type: "tool_result", tool_use_id: "item_1", is_error: true, content: "fail-message\n" },
			toolUseId: "item_1",
			content: "fail-message\n",
		});
	});

	it("normalizes a failed Codex turn boundary", () => {
		expect(adapter.parseLine(JSON.stringify({ type: "turn.failed", error: "model unavailable" }))).toEqual([
			{ kind: "turn_end", raw: { type: "turn.failed", error: "model unavailable" }, isError: true, result: "model unavailable" },
		]);
	});

	it("tolerates the non-JSON lines that share the one-shot output path", () => {
		expect(adapter.parseLine("Reading additional input from stdin...")).toEqual([]);
		expect(adapter.parseLine("2026-09-01T01:49:15Z ERROR oauth refresh failed")).toEqual([]);
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
