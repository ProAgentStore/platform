import { describe, expect, it } from "vitest";
import { engineContinuity, engineContinuityNote } from "./engine-continuity.js";

describe("engineContinuity — persistent vs one-shot, derived from the command", () => {
	it("calls Claude persistent — it is the only engine the runner keeps alive across turns", () => {
		expect(engineContinuity("claude --dangerously-skip-permissions")).toBe("persistent");
	});

	it("calls every shipped raw default one-shot", () => {
		// The four non-Claude DEFAULT_ENGINES. Each is respawned per turn by `runOneShot`.
		expect(engineContinuity("codex exec --sandbox danger-full-access")).toBe("one-shot");
		expect(engineContinuity("gemini --approval-mode yolo --skip-trust --prompt")).toBe("one-shot");
		expect(engineContinuity("grok --permission-mode bypassPermissions -p")).toBe("one-shot");
		expect(engineContinuity("ollama run llama3")).toBe("one-shot");
	});

	it("follows the BINARY through wrappers and env prefixes, like deriveClientType does", () => {
		// The reason this is derived rather than a per-engine table: the answer belongs to the
		// command's real binary, not to the preset's id or label. A table keyed on "codex" would
		// call `npx claude` one-shot and be wrong about the one engine that isn't.
		expect(engineContinuity("npx claude --dangerously-skip-permissions")).toBe("persistent");
		expect(engineContinuity("FOO=bar env claude -p")).toBe("persistent");
		expect(engineContinuity("/opt/homebrew/bin/claude")).toBe("persistent");
		expect(engineContinuity("npx codex exec")).toBe("one-shot");
	});

	it("calls an unrecognised binary one-shot — matching what the runner will actually do", () => {
		// `deriveClientType` maps an unknown binary to "codex" so it runs RAW rather than being
		// mis-driven as Claude. The label has to agree with that, or it promises a memory the
		// engine will not have.
		expect(engineContinuity("my-model --flag")).toBe("one-shot");
		expect(engineContinuity("./scripts/my-wrapper.sh")).toBe("one-shot");
	});
});

describe("engineContinuityNote — what the engines panel says", () => {
	it("says nothing for a preset with no command yet", () => {
		// A row the user has just added. Claiming it keeps its session would be a statement about
		// a preset that does not exist, and wrong the moment they type `codex`.
		expect(engineContinuityNote("")).toBeNull();
		expect(engineContinuityNote("   ")).toBeNull();
	});

	it("warns that a raw engine forgets the conversation, and says the repo edits survive", () => {
		const note = engineContinuityNote("codex exec --sandbox danger-full-access");
		expect(note?.continuity).toBe("one-shot");
		expect(note?.label).toMatch(/no memory/i);
		// The half that stops the warning reading as "it undoes its work": the engine is amnesiac
		// about the conversation, not about the working tree.
		expect(note?.detail).toMatch(/survive/i);
	});

	it("states the positive case for Claude rather than staying silent", () => {
		const note = engineContinuityNote("claude --dangerously-skip-permissions");
		expect(note?.continuity).toBe("persistent");
		expect(note?.label).toMatch(/between turns/i);
	});
});
