import { describe, expect, it } from "vitest";
import { engineInvocationBadge, engineInvocationNote } from "./engine-invocation-mode.js";

describe("engineInvocationNote — the read-only mode chip in the engines panel (#731)", () => {
	it("labels structured commands without offering a choice", () => {
		expect(engineInvocationNote("claude --dangerously-skip-permissions")).toMatchObject({ mode: "structured", label: "structured" });
		expect(engineInvocationNote("codex exec --json --sandbox danger-full-access")).toMatchObject({ mode: "structured", label: "structured" });
	});

	it("labels legitimate raw commands without making them faults", () => {
		const note = engineInvocationNote("grok --permission-mode bypassPermissions -p");
		expect(note).toMatchObject({ mode: "raw", label: "raw" });
		expect(note?.detail).toMatch(/stdout/i);
	});

	it("names Codex fallback commands as raw", () => {
		expect(engineInvocationNote("codex")?.mode).toBe("raw");
		expect(engineInvocationNote("codex exec resume thread-1")?.mode).toBe("raw");
	});

	it("says nothing for an empty preset row", () => {
		expect(engineInvocationNote("")).toBeNull();
		expect(engineInvocationNote("   ")).toBeNull();
	});
});

describe("engineInvocationBadge — the live engine report (#731)", () => {
	it("surfaces the runner-reported warning when a capable engine ran raw", () => {
		const badge = engineInvocationBadge({
			expected: "structured",
			resolved: "raw",
			warning: "running raw — structured not available on this machine's codex CLI",
		});
		expect(badge?.tone).toBe("warn");
		expect(badge?.label).toMatch(/raw/i);
	});

	it("uses the expected mode only when an older runner reports nothing", () => {
		const badge = engineInvocationBadge({ expected: "structured", resolved: null, warning: null });
		expect(badge?.tone).toBe("neutral");
		expect(badge?.detail).toMatch(/Expected on a current runner/i);
	});
});
