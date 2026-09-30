import { describe, expect, it } from "vitest";
import { ENGINE_CHECK_MIN_CLI, enginePreflightMessage } from "./engine-preflight.js";

/** Every sentence a preflight can put in front of the owner (#879). */
describe("enginePreflightMessage", () => {
	const machine = 'machine "pink-laptop"';

	it("a missing binary names the engine, the machine, the executable and how to install it", () => {
		const msg = enginePreflightMessage("no-binary", { clientType: "codex", bin: "codex", machine });
		expect(msg).toContain('Codex is not installed on machine "pink-laptop"');
		expect(msg).toContain("`codex`");
		expect(msg).toContain("npm i -g @openai/codex");
		expect(msg).toContain("codex login");
	});

	it("a signed-out engine is sent to its subscription sign-in or coding_engine_reauth", () => {
		const msg = enginePreflightMessage("signed-out", { clientType: "claude", machine });
		expect(msg).toContain("Claude Code is installed on machine \"pink-laptop\" but not signed in");
		expect(msg).toContain("/login");
		expect(msg).toContain("coding_engine_reauth");
	});

	it("an outdated runner is told the version it needs and runner_update", () => {
		const msg = enginePreflightMessage("outdated", { clientType: "codex", machine });
		expect(msg).toContain(ENGINE_CHECK_MIN_CLI);
		expect(msg).toContain("runner_update");
	});

	it("never offers an API key as the remedy, for any engine or state", () => {
		for (const clientType of ["claude", "codex", "gemini", "grok"] as const) {
			for (const state of ["no-binary", "signed-out", "outdated", "unreachable"] as const) {
				expect(enginePreflightMessage(state, { clientType, machine })).not.toMatch(/api[ _-]?key/i);
			}
		}
	});
});
