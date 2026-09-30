/** #882: a dead engine session reports what it said, and names a missing binary. */
import { describe, expect, it } from "vitest";
import { deadSessionDetail, lastEngineWords } from "./coding-dead-session.js";

describe("deadSessionDetail", () => {
	it("names a binary that is not on PATH — both runner phrasings", () => {
		for (const pane of [
			"⏺ starting\n[codex] failed to start: spawn codex ENOENT",
			"[cannot run `/usr/local/bin/codex`: spawn /usr/local/bin/codex ENOENT — is codex installed and on your PATH?]",
		]) {
			const d = deadSessionDetail(pane);
			expect(d).toContain("`codex` is not installed on the runner");
			expect(d).toContain("ENOENT");
			expect(d.startsWith("coding session is not running")).toBe(true);
		}
	});

	it("says 'not executable' for EACCES", () => {
		expect(deadSessionDetail("[grok] failed to start: spawn grok EACCES")).toContain("`grok` exists on the runner but is not executable");
	});

	it("carries the last lines, including an exit code, when the cause is anything else", () => {
		const d = deadSessionDetail("working…\n\nError: config.toml: unknown key `sandbox`\n[codex exited with code 1]\n");
		expect(d).toBe("coding session is not running. The engine's last output: working… | Error: config.toml: unknown key `sandbox` | [codex exited with code 1]");
	});

	it("says outright when there was no output at all", () => {
		expect(deadSessionDetail("")).toBe("coding session is not running (the engine produced no output)");
		expect(deadSessionDetail("\n  \n")).toBe("coding session is not running (the engine produced no output)");
	});
});

describe("lastEngineWords", () => {
	it("keeps the last six lines and caps the length", () => {
		const pane = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
		expect(lastEngineWords(pane)).toBe("line 4 | line 5 | line 6 | line 7 | line 8 | line 9");
		expect(lastEngineWords("x".repeat(2000)).length).toBe(601);
	});
});
