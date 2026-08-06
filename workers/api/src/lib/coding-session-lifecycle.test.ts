import { describe, expect, it } from "vitest";
import { noSessionMessage, shouldEndSessionAfterRun } from "./coding-session-lifecycle.js";
import { classifySubordinateConnectivity } from "./subordinate-connectivity.js";

const NOW = Date.parse("2026-08-06T06:00:00Z");
const connected = classifySubordinateConnectivity({
	requiresRunner: true,
	hasRuntimeRow: true,
	relayConnected: true,
	node: "macbook",
	runnerVersion: "0.4.32",
	now: NOW,
});
const offline = classifySubordinateConnectivity({
	requiresRunner: true,
	hasRuntimeRow: true,
	relayConnected: false,
	node: "studio",
	lastSeenAt: "2026-08-06 05:00:00",
	now: NOW,
});

describe("shouldEndSessionAfterRun", () => {
	it("leaves a session the run did not open", () => {
		// THE bug (#271). The Pilot ended the session unconditionally while the driver required a
		// live one, so every delegated job consumed the session it needed and the next one 409'd.
		// Reproduced three times in one afternoon with the runner online throughout.
		expect(shouldEndSessionAfterRun({ openedByRun: false })).toBe(false);
	});

	it("closes the session it opened itself", () => {
		// The other half: on-demand open would otherwise leak an idle claimed session per
		// delegated job, and the repo would fill up with sessions nobody asked for.
		expect(shouldEndSessionAfterRun({ openedByRun: true })).toBe(true);
	});

	it("does not depend on how the run ended", () => {
		// Considered and deliberately rejected. A failed run is the WORST moment to close a
		// human's session — that is exactly when they want to open the terminal and look at it.
		// And a run that opened its own session must clean up whether it succeeded or not.
		expect(shouldEndSessionAfterRun({ openedByRun: false })).toBe(false);
		expect(shouldEndSessionAfterRun({ openedByRun: true })).toBe(true);
	});
});

describe("noSessionMessage", () => {
	it("never mentions pags up when the runner is connected", () => {
		// The message that cost a real user hours. The old text appended "(and run `pags up`)"
		// unconditionally, so an agent faithfully relayed "start your runner" to someone whose
		// runner was connected, heartbeating and serving other work.
		const msg = noSessionMessage({ repoName: "fas/platform", connectivity: connected });
		expect(msg).toContain("The runner is connected");
		expect(msg).toContain("macbook");
		// It may only NAME `pags up` to rule it out. Anything that reads as an instruction to run
		// it is the regression: the whole cost of this bug was a user acting on that sentence.
		expect(msg).toContain("not a `pags up` problem");
		expect(msg).not.toMatch(/\brun `pags up|start (one|a runner)/i);
	});

	it("does prescribe pags up — and names the machine — when the runner is really down", () => {
		// The inverse failure is just as bad: a refusal with no remedy leaves a multi-machine
		// user guessing which laptop to wake.
		const msg = noSessionMessage({ repoName: "fas/platform", connectivity: offline });
		expect(msg).toContain("pags up");
		expect(msg).toContain("studio");
	});

	it("says --force, not pags up, for a live machine holding the agent elsewhere", () => {
		// `pags up` would just be rejected again with 4409. Relaying the generic remedy here is
		// how a user ends up running the same failing command repeatedly.
		const detached = classifySubordinateConnectivity({
			requiresRunner: true,
			hasRuntimeRow: true,
			relayConnected: false,
			node: "macbook",
			lastSeenAt: "2026-08-06 05:59:50",
			now: NOW,
		});
		expect(noSessionMessage({ repoName: "r", connectivity: detached })).toContain("pags up --force");
	});

	it("surfaces the runner's own error when the session could not be started", () => {
		// A clone failure or a bad engine command is actionable; "no live coding session" is not.
		// Without this the user sees a generic refusal for a completely specific problem.
		const msg = noSessionMessage({ repoName: "r", connectivity: connected, startError: "fatal: repository not found" });
		expect(msg).toContain("fatal: repository not found");
		expect(msg).not.toMatch(/\brun `pags up/i);
	});
});
