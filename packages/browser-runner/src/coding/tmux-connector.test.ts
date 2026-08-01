import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import {
	capturePane,
	createSession,
	killSession,
	listSessionsDetailed,
	runCommand,
	sessionExists,
} from "./tmux.js";

/** Skip the whole suite when tmux isn't installed (CI images without it). */
const HAS_TMUX = (() => {
	try {
		execFileSync("tmux", ["-V"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

const SESSION = "pags-tmux-connector-test";

describe.runIf(HAS_TMUX)("tmux connector primitives", () => {
	afterAll(() => {
		killSession(SESSION);
	});

	it("lists a created session with rich info", () => {
		killSession(SESSION); // clean slate
		createSession(SESSION, process.cwd());
		expect(sessionExists(SESSION)).toBe(true);
		const found = listSessionsDetailed().find((s) => s.name === SESSION);
		expect(found).toBeTruthy();
		expect(found?.windows).toBeGreaterThanOrEqual(1);
		expect(typeof found?.activeCommand).toBe("string");
	});

	it("runs a command and captures its output in the pane", async () => {
		runCommand(SESSION, "echo tmux_connector_marker_42");
		// Give the shell a beat to render.
		await new Promise((r) => setTimeout(r, 400));
		const pane = capturePane(SESSION, 200);
		expect(pane).toContain("tmux_connector_marker_42");
	});

	it("kills the session", () => {
		expect(killSession(SESSION)).toBe(true);
		expect(sessionExists(SESSION)).toBe(false);
	});
});
