import { describe, expect, it } from "vitest";
import { handlerFor } from "./handlers.js";

describe("handlerFor — the fallback launch command", () => {
	it("is never the bare binary for a shipped engine", () => {
		// Only reachable when a session arrives with no command of its own (an older cloud, a
		// preset saved blank), which is exactly when nobody is watching. The bare `codex` / `grok` /
		// `gemini` launches the interactive TUI, and a headless runner has no PTY — so the engine
		// dies on "stdin is not a terminal" and the session looks idle and broken. The cloud's
		// DEFAULT_ENGINES presets carry the non-interactive, write-enabled form; this fallback has
		// to be the same shape or it silently contradicts them.
		for (const engine of ["codex", "grok", "gemini"] as const) {
			const command = handlerFor(engine).cliCommand;
			expect(command).not.toBe(engine); // not the bare binary
			expect(command.split(/\s+/).length).toBeGreaterThan(1); // carries its posture flags
			expect(command.split(/\s+/)[0]).toBe(engine); // ...and still launches ITS OWN cli
		}
	});

	it("keeps Claude's write flag, the one that has always been there", () => {
		expect(handlerFor("claude").cliCommand).toContain("--dangerously-skip-permissions");
	});

	it("falls back to the generic entry for an unknown engine", () => {
		expect(handlerFor("nope" as never).clientType).toBe("generic");
	});
});
