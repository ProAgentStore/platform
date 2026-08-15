import { describe, expect, it } from "vitest";
import { noticeSentence, runnerOfflineNotice } from "./runner-offline-notice";

/** The server's answer for the #537 state: session on A, A gone, B running `pags up`. */
const SESSION_ELSEWHERE = {
	state: "session-machine-offline",
	message:
		"This session is running on RLs-MacBook-Air.local, which isn't connected. Sergeys-Mac-mini.local is connected — open the session again to move it to Sergeys-Mac-mini.local, or start the runner on RLs-MacBook-Air.local.",
	remedy: null,
};

const MACHINE_OFF = { state: "runner-offline", message: "The runner for this agent isn't running.", remedy: "pags up" };

describe("runnerOfflineNotice — the banner stops instructing an owner who is already running `pags up` (#537)", () => {
	// The regression this exists to prevent. Before #537 the banner had only `runnerOnline` and
	// rendered "Start the runner: pags up" for exactly this state.
	it("a session stamped to an offline machine names both machines and offers no command", () => {
		const n = runnerOfflineNotice({ runnerOnline: false, sessionAttachment: SESSION_ELSEWHERE });
		expect(n?.text).toContain("RLs-MacBook-Air.local");
		expect(n?.text).toContain("Sergeys-Mac-mini.local");
		expect(n?.command).toBeUndefined();
		expect(n?.text).not.toContain("pags up");
	});

	it("a machine that really is off still gets the command — this is not a blanket suppression", () => {
		const n = runnerOfflineNotice({ runnerOnline: false, relayAttachment: MACHINE_OFF });
		expect(n?.text).toBe("The runner for this agent isn't running.");
		expect(n?.command).toBe("pags up");
	});

	// Same priority `resolveRunnerOnline` used to REACH the offline verdict. Explaining it with the
	// other reading is how a banner contradicts itself: the relay says "attached · Connected."
	// in the very state the session says it cannot be reached.
	it("the session answer outranks the instance answer, because that is where the verdict came from", () => {
		const n = runnerOfflineNotice({
			runnerOnline: false,
			sessionAttachment: SESSION_ELSEWHERE,
			relayAttachment: { state: "attached", message: "Connected.", remedy: null },
		});
		expect(n?.text).toContain("open the session again");
	});

	it("falls back to the instance answer when no session has reported", () => {
		const n = runnerOfflineNotice({ runnerOnline: false, sessionAttachment: null, relayAttachment: MACHINE_OFF });
		expect(n?.command).toBe("pags up");
	});

	it("an answer with no sentence is not an answer — the older API and the empty case fall through", () => {
		const n = runnerOfflineNotice({
			runnerOnline: false,
			sessionAttachment: { state: "session-machine-offline", message: "  ", remedy: null },
		});
		expect(n?.text).toBe("Your machine isn't connected. Start the runner:");
		expect(n?.command).toBe("pags up");
	});
});

describe("runnerOfflineNotice — when there is nothing to say", () => {
	// `null` is "no reading yet". A falsy test here would flash "your machine isn't connected" on
	// every first paint, which is the mistake ./repo-status documents at length.
	it("says nothing while online or unknown", () => {
		expect(runnerOfflineNotice({ runnerOnline: true, sessionAttachment: SESSION_ELSEWHERE })).toBeNull();
		expect(runnerOfflineNotice({ runnerOnline: null, relayAttachment: MACHINE_OFF })).toBeNull();
	});
});

describe("noticeSentence — the same notice where a code block cannot go (a title attribute)", () => {
	it("keeps the command, so a flattened remedy is still a remedy", () => {
		const n = runnerOfflineNotice({ runnerOnline: false, relayAttachment: MACHINE_OFF });
		expect(noticeSentence(n)).toBe("The runner for this agent isn't running. Run `pags up`.");
	});

	it("adds nothing when the server offers no command — the #537 case has no one to run", () => {
		const n = runnerOfflineNotice({ runnerOnline: false, sessionAttachment: SESSION_ELSEWHERE });
		expect(noticeSentence(n)).toBe(SESSION_ELSEWHERE.message);
		expect(noticeSentence(n)).not.toContain("pags up");
	});

	it("does not turn the colon fallback into two sentences", () => {
		expect(noticeSentence(runnerOfflineNotice({ runnerOnline: false }))).toBe("Your machine isn't connected. Start the runner: `pags up`");
	});

	it("is empty when there is no notice, so a caller can spread it without a guard", () => {
		expect(noticeSentence(null)).toBe("");
	});
});
