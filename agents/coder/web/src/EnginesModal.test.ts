import { describe, expect, it } from "vitest";
import { missingWriteFlag } from "./EnginesModal";

describe("missingWriteFlag", () => {
	it("flags the preset that shipped read-only", () => {
		// `codex exec` with no --sandbox inherits `sandbox: read-only`. The engine explored the
		// repo, answered well, and could not edit a file or even `git pull`. Nothing failed loudly,
		// which is exactly why the editor has to say so.
		expect(missingWriteFlag("codex exec")).toBe("--sandbox danger-full-access");
	});

	it("stays quiet once the flag is there, whichever form", () => {
		expect(missingWriteFlag("codex exec --sandbox danger-full-access")).toBeNull();
		expect(missingWriteFlag("codex exec --sandbox workspace-write")).toBeNull();
		expect(missingWriteFlag("codex exec --dangerously-bypass-approvals-and-sandbox")).toBeNull();
		expect(missingWriteFlag("claude --dangerously-skip-permissions")).toBeNull();
		expect(missingWriteFlag("gemini --approval-mode yolo --prompt")).toBeNull();
		expect(missingWriteFlag("gemini -y --prompt")).toBeNull();
		expect(missingWriteFlag("grok --permission-mode bypassPermissions -p")).toBeNull();
	});

	it("flags each known engine's bare form", () => {
		expect(missingWriteFlag("claude")).toBe("--dangerously-skip-permissions");
		expect(missingWriteFlag("gemini --prompt")).toBe("--approval-mode yolo");
		expect(missingWriteFlag("grok -p")).toBe("--permission-mode bypassPermissions");
	});

	it("does not guess for an engine it does not know", () => {
		// A local model or a custom wrapper has no permission concept to nag about; a wrong
		// warning on every custom preset would train people to ignore the real one.
		expect(missingWriteFlag("ollama run llama3")).toBeNull();
		expect(missingWriteFlag("my-agent --go")).toBeNull();
		expect(missingWriteFlag("")).toBeNull();
	});

	it("sees past wrappers and env prefixes", () => {
		expect(missingWriteFlag("FOO=bar npx codex exec")).toBe("--sandbox danger-full-access");
		expect(missingWriteFlag("/opt/bin/codex exec --sandbox workspace-write")).toBeNull();
	});
});
