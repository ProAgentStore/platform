import { describe, expect, it } from "vitest";
import { noSessionMessage, pilotStopSignal, shouldEndSessionAfterRun } from "./coding-session-lifecycle.js";
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

describe("pilotStopSignal — the Pilot's Stop button (#374)", () => {
	it("stops on the loop-run cancel flag, which nothing in the Pilot used to read", () => {
		// THE regression this guards. `POST /loop/:runId/cancel` sets `cancel_requested`;
		// `AgentLoopWorkflow` reads it at the top of each iteration and `CodingSessionWorkflow`
		// never did. Harmless while the Coding tab's Loop lived in the browser (Stop meant "stop
		// scheduling"), fatal the moment that Loop became a Pilot run: the user would press Stop,
		// the server would record it, and the engine would keep going and keep spending.
		expect(pilotStopSignal({ sessionStatus: "active", cancelRequested: true })).toEqual({
			stop: true,
			reason: "Stopped by you.",
		});
	});

	it("still stops when the session is ended or errored", () => {
		// Kill / End / Restart. The pre-existing signal, unchanged.
		expect(pilotStopSignal({ sessionStatus: "ended" }).stop).toBe(true);
		expect(pilotStopSignal({ sessionStatus: "error" }).stop).toBe(true);
	});

	it("says nothing extra when the session simply went away", () => {
		// A bare `cancelled` outcome reads as "the run was stopped"; adding a reason here would
		// claim a decision nobody made.
		expect(pilotStopSignal({ sessionStatus: "ended" }).reason).toBeUndefined();
	});

	it("prefers the user's reason when both signals are set", () => {
		// Stop → cancel flag → the Pilot ends the session on its way out, so both are true at the
		// close. "Stopped by you" is the fact; "the session ended" is what that looks like from
		// underneath, and reporting it would make a deliberate stop unattributable.
		expect(pilotStopSignal({ sessionStatus: "ended", cancelRequested: true }).reason).toBe("Stopped by you.");
	});

	it("does NOT stop on `suspended`", () => {
		// `pags up --force` on another machine suspends sessions owned by other nodes, and
		// `reassignSessionNode` deliberately leaves the status alone — so a session relocated to a
		// live machine can legitimately sit suspended. Stopping here would end a healthy run at
		// step 0, undoing the relocation the workflow performs a few lines earlier.
		expect(pilotStopSignal({ sessionStatus: "suspended" }).stop).toBe(false);
	});

	it("does NOT stop on an unreadable status", () => {
		// A D1 blip must not abort a run that is working.
		expect(pilotStopSignal({ sessionStatus: null }).stop).toBe(false);
		expect(pilotStopSignal({}).stop).toBe(false);
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
