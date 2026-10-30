import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	capturePane,
	capturePaneSince,
	createSession,
	extractBetweenMarkers,
	killSession,
	listSessionsDetailed,
	makeRunMarkers,
	runCommand,
	sessionExists,
	waitForMarker,
	wrapWithMarkers,
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

// Unique per run (#1254): a fixed name collided with another checkout running this same suite at the same time.
const SESSION = `pags-tmux-connector-test-${process.pid}`;

/**
 * A tmux server of this suite's own (#1360). The unique name above stopped two runs colliding on a session, but they still
 * shared the machine's ONE default tmux server — and that server exits the instant its last session does. Under full-suite load
 * another process's cleanup could take it down between two of these tests: "no server running on /tmp/tmux-502/default".
 * tmux takes its socket directory from `$TMUX_TMPDIR`, and from `$TMUX` when the suite itself runs inside tmux, so the whole
 * file points both at a private directory (short: a unix socket path is capped near 104 characters) and kills that server after.
 */
let tmuxTmp = "";
const saved = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX: process.env.TMUX };
const restoreEnv = (k: "TMUX_TMPDIR" | "TMUX") => {
	if (saved[k] === undefined) delete process.env[k];
	else process.env[k] = saved[k];
};

/** Poll until `cond` holds: an upper bound on a shell starting and rendering, never a deadline under test. */
async function until(cond: () => boolean, what: string, timeoutMs = 45_000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

describe.runIf(HAS_TMUX)("tmux connector primitives", () => {
	beforeAll(() => {
		tmuxTmp = mkdtempSync("/tmp/ptc-");
		process.env.TMUX_TMPDIR = tmuxTmp;
		delete process.env.TMUX;
	});
	afterAll(() => {
		killSession(SESSION);
		try {
			execFileSync("tmux", ["kill-server"], { stdio: "ignore" });
		} catch {
			/* no server left to stop */
		}
		restoreEnv("TMUX_TMPDIR");
		restoreEnv("TMUX");
		rmSync(tmuxTmp, { recursive: true, force: true });
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
		// Until the shell has rendered it — not a fixed beat that a loaded machine outruns.
		await until(() => capturePane(SESSION, 200).includes("tmux_connector_marker_42"), "the shell to render the command's output");
		expect(capturePane(SESSION, 200)).toContain("tmux_connector_marker_42");
	});

	/**
	 * #1406 end to end, against a real tmux session that already has the PRIOR test's history in
	 * it — exactly the scenario that was filed: an earlier command's output must not leak into
	 * this one's result, and the end marker's exit code must be the real one.
	 */
	it("a marker-wrapped run returns only its own output and exit code, never the session's earlier history", async () => {
		const markers = makeRunMarkers();
		runCommand(SESSION, wrapWithMarkers("echo tmux_connector_marker_NEW", markers));
		const rawPane = await waitForMarker(SESSION, markers, { timeoutMs: 10_000, pollMs: 50 });
		const result = extractBetweenMarkers(rawPane, markers);
		expect(result.completed).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.truncated).toBe(false);
		expect(result.output).toBe("tmux_connector_marker_NEW");
		// The prior test's output is still in the pane's scrollback, but not in the extracted result.
		expect(rawPane).toContain("tmux_connector_marker_42");
		expect(result.output).not.toContain("tmux_connector_marker_42");
	});

	it("a marker-wrapped run reports a non-zero exit code", async () => {
		const markers = makeRunMarkers();
		runCommand(SESSION, wrapWithMarkers("false", markers));
		const rawPane = await waitForMarker(SESSION, markers, { timeoutMs: 10_000, pollMs: 50 });
		const result = extractBetweenMarkers(rawPane, markers);
		expect(result.completed).toBe(true);
		expect(result.exitCode).toBe(1);
	});

	it("tmux_capture_pane's since cursor returns only what a plain command adds next (#1406)", async () => {
		const first = capturePaneSince(SESSION, undefined);
		runCommand(SESSION, "echo tmux_connector_since_probe");
		await until(() => capturePane(SESSION, 200).includes("tmux_connector_since_probe"), "the probe command to render");
		const second = capturePaneSince(SESSION, first.cursor);
		expect(second.sinceValid).toBe(true);
		expect(second.pane).toContain("tmux_connector_since_probe");
		expect(second.pane).not.toContain("tmux_connector_marker_42"); // already covered by the first cursor
	});

	it("kills the session", () => {
		expect(killSession(SESSION)).toBe(true);
		expect(sessionExists(SESSION)).toBe(false);
	});
});
