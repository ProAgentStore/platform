import { describe, expect, it } from "vitest";
import { engineTurnNotice } from "./engine-turn-view";

/**
 * #545 — the exit code was on the page and read as ordinary output.
 *
 * The production pane, three times over: `[codex exited with code 1]`, under a line explaining
 * exactly why. The owner read the tab and reported the engine as broken; nothing on the page
 * distinguished "the engine refused" from "the engine said something".
 */
describe("engineTurnNotice", () => {
	it("says what the engine did, quotes it, and names the class of problem", () => {
		const n = engineTurnNotice({
			verdict: "failed",
			exitCode: 1,
			signal: null,
			at: 1,
			detail: "Not inside a trusted directory and --skip-git-repo-check was not specified.",
		});
		expect(n?.label).toBe("The engine exited with code 1 on its last turn");
		expect(n?.evidence).toContain("--skip-git-repo-check");
		// The expensive mistake is rewording the instruction, which addresses nothing.
		expect(n?.detail).toMatch(/refusing to run/i);
	});

	it("does not invent an exit code the engine never reported", () => {
		// Claude's structured path has no exit code — the verdict comes from the `result` event's
		// `is_error`. "exited with code null" would be worse than the sentence it replaces.
		const n = engineTurnNotice({ verdict: "failed", exitCode: null, signal: null, at: 1 });
		expect(n?.label).toBe("The engine reported its last turn as failed");
		expect(n?.evidence).toBeNull();
	});

	it("says NOTHING for the four cases where there is nothing honest to say", () => {
		expect(engineTurnNotice(null)).toBeNull(); // runner older than CLI 0.4.51, or no turn yet
		expect(engineTurnNotice(undefined)).toBeNull();
		expect(engineTurnNotice({ verdict: "ok", exitCode: 0, at: 1 })).toBeNull();
		// WE killed it (the wedge ceiling, an interrupt) — the pane already carries that line and it
		// is not evidence about the engine.
		expect(engineTurnNotice({ verdict: "killed", exitCode: null, signal: "SIGTERM", at: 1 })).toBeNull();
		// A verdict this build does not know: the runner is a published package and may be newer.
		expect(engineTurnNotice({ verdict: "something-new", at: 1 })).toBeNull();
	});
});
