import { describe, expect, it } from "vitest";
import { engineMeteringNote } from "./engine-metering-note.js";

describe("engineMeteringNote — what the engines panel says about a preset's spend (#556)", () => {
	it("says nothing for a preset with no command yet", () => {
		// A row the user has just added. `isClaudeEngine("")` answers true, so an unguarded version
		// would assert "spend is measured" against a preset that does not exist — and be wrong the
		// moment they type `codex`. Same guard as the continuity note, same reason.
		expect(engineMeteringNote("")).toBeNull();
		expect(engineMeteringNote("   ")).toBeNull();
	});

	it("says a raw engine's spend cannot be measured — and that this is not the same as free", () => {
		// The whole point. A missing ledger row renders as zero dollars, so the sentence has to
		// distinguish "nothing was spent" from "we could not see it"; #348's own framing.
		const note = engineMeteringNote("codex exec --sandbox danger-full-access");
		expect(note?.metered).toBe(false);
		expect(note?.label).toMatch(/not measured/i);
		expect(note?.detail).toMatch(/invisible/i);
		expect(note?.detail).toMatch(/usage/i);
	});

	it("covers every raw engine the platform ships as a default, not just codex", () => {
		// `DEFAULT_ENGINES` offers all of these as equals; two thirds of that list is unmeasurable
		// and the panel said so about none of it.
		for (const cmd of ["grok --permission-mode bypassPermissions -p", "gemini --approval-mode yolo --prompt", "my-wrapper.sh"]) {
			expect(engineMeteringNote(cmd)?.metered).toBe(false);
		}
	});

	it("states the positive case for Claude Code rather than staying silent", () => {
		const note = engineMeteringNote("claude --dangerously-skip-permissions");
		expect(note?.metered).toBe(true);
		expect(note?.label).toMatch(/measured/i);
	});

	it("follows the BINARY through wrappers, so `npx claude` is not mistaken for a raw engine", () => {
		// The answer belongs to the command's real binary — which is why this is derived from the
		// SDK's mirror of `deriveClientType` rather than keyed on the preset's id or label.
		expect(engineMeteringNote("npx claude -p")?.metered).toBe(true);
		expect(engineMeteringNote("/opt/homebrew/bin/claude")?.metered).toBe(true);
		expect(engineMeteringNote("npx codex exec")?.metered).toBe(false);
	});
});
