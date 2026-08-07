import { describe, expect, it } from "vitest";
import { isEngineBusy } from "./engine-busy";
import {
	type RepoSignals,
	type RepoState,
	type RunnerOnline,
	repoStatusLabel,
	resolveRepoState,
	sessionBadge,
	terminalPollBusy,
} from "./repo-status";

/**
 * Everything the tab can ever hold for a repo:
 *
 *   - the three states the runner emits (`idle | thinking | responding`)
 *   - `working`, the legacy alias engine-busy.ts still accepts
 *   - `offline`, which the tab itself writes when a `/capture` REJECTS
 *   - `undefined`, before the first poll answers — the state the landing view is in for its
 *     first 3s, and the one every hand-written chain forgot
 */
const STATES = [undefined, "idle", "thinking", "responding", "working", "offline"] as const;
const ONLINE: RunnerOnline[] = [true, false, null];

const grid = (runnerOnline: RunnerOnline, hasActiveSession: boolean) =>
	STATES.map((state) => resolveRepoState({ state, runnerOnline, hasActiveSession }));

describe("the whole reconciliation, pinned", () => {
	// Read as: idle-first-poll · idle · thinking · responding · working · offline
	// With no active session the runState is IGNORED — it belongs to an engine that no longer
	// exists, and `repoStatuses` is not rewritten once the last session ends, so it would say
	// "Working..." forever. Hence the four flat rows.
	const TABLE: Array<[RunnerOnline, boolean, RepoState[]]> = [
		[true, true, ["active", "ready", "working", "working", "working", "offline"]],
		[true, false, ["ready", "ready", "ready", "ready", "ready", "ready"]],
		[false, true, ["offline", "offline", "working", "working", "working", "offline"]],
		[false, false, ["offline", "offline", "offline", "offline", "offline", "offline"]],
		[null, true, ["active", "ready", "working", "working", "working", "offline"]],
		[null, false, ["ready", "ready", "ready", "ready", "ready", "ready"]],
	];

	for (const [runnerOnline, hasActiveSession, expected] of TABLE) {
		it(`runner=${String(runnerOnline)} activeSession=${hasActiveSession}`, () => {
			expect(grid(runnerOnline, hasActiveSession)).toEqual(expected);
		});
	}
});

describe("the properties the table is FOR", () => {
	it("never reports offline on the strength of an UNANSWERED runner alone", () => {
		// `runnerOnline === false`, never `!runnerOnline`. `null` is "no answer yet", and one
		// falsy test would put "Your machine isn't connected — run pags up" on every first paint,
		// which is the shape of #241 in the other direction.
		//
		// The explicit `offline` state is excluded because it is not an absence: the poll writes
		// it when a `/capture` REJECTED, which is a first-hand answer about this repo.
		for (const state of STATES.filter((s) => s !== "offline")) {
			for (const hasActiveSession of [true, false]) {
				expect(resolveRepoState({ state, runnerOnline: null, hasActiveSession })).not.toBe("offline");
			}
		}
	});

	it("treats 'not answered yet' exactly like 'connected' — it differs nowhere", () => {
		for (const hasActiveSession of [true, false]) {
			expect(grid(null, hasActiveSession)).toEqual(grid(true, hasActiveSession));
		}
	});

	it("says `working` for exactly the states engine-busy calls busy — no second vocabulary", () => {
		// The bug engine-busy.ts exists for was five call sites each spelling out
		// `state === "thinking" || state === "working"`: `working` is never emitted and
		// `responding` fell through as NOT busy, so the Loop could fire the next instruction into
		// an engine that was still talking. Derived rather than listed, so a re-scatter here
		// fails without anyone having to notice it.
		for (const state of STATES) {
			for (const runnerOnline of ONLINE) {
				const busy = resolveRepoState({ state, runnerOnline, hasActiveSession: true }) === "working";
				expect(busy).toBe(isEngineBusy(state));
			}
		}
	});

	it("never says `working` for a repo with no session, whatever the map still holds", () => {
		// `pollStatuses` returns early when nothing is active, so the final state of a finished
		// run is never cleared. Trusting it would leave a repo spinning forever after the engine
		// it described stopped existing.
		for (const state of STATES) {
			for (const runnerOnline of ONLINE) {
				expect(resolveRepoState({ state, runnerOnline, hasActiveSession: false })).not.toBe("working");
			}
		}
	});

	it("a live turn outranks a runner the relay believes is gone", () => {
		// `runState` comes from a capture that just answered; `relay.connected` is on its own 10s
		// timer. Reporting a working engine as offline because of a stale tick is the same lie in
		// the other direction — and it would also drop the terminal poll to the passive tier
		// mid-turn.
		expect(resolveRepoState({ state: "responding", runnerOnline: false, hasActiveSession: true })).toBe("working");
	});

	it("distinguishes 'nothing has reported yet' from 'reported idle'", () => {
		// Both have a session; only one of them is a claim about the engine.
		expect(resolveRepoState({ state: undefined, runnerOnline: true, hasActiveSession: true })).toBe("active");
		expect(resolveRepoState({ state: "idle", runnerOnline: true, hasActiveSession: true })).toBe("ready");
	});
});

describe("the fix: a repo row can no longer contradict the banner above it", () => {
	// `GET …/capture` answers `{ runState: "idle", runnerConnected: false }` when no runner is
	// connected — there is no engine to ask, so it reports the engine idle. The poll stored
	// "idle", and the row's phrase consulted `runnerOnline` only on the branch where the repo had
	// NO active session. So a repo with a live session on a machine that had gone away read
	// "Ready", with a green dot, directly under ReposList's "Your machine isn't connected. Start
	// the runner: pags up" — which reads off the SAME `runnerOnline`.
	const offlineWithLiveSession: RepoSignals = { state: "idle", runnerOnline: false, hasActiveSession: true };

	it("says Runner offline where it used to say Ready", () => {
		expect(repoStatusLabel(offlineWithLiveSession)).toBe("Runner offline");
	});

	it("and the header badge agrees, because it is the same verdict", () => {
		expect(sessionBadge(resolveRepoState(offlineWithLiveSession))).toEqual({ label: "Error", tone: "error" });
	});

	/**
	 * The chain as it stood before this module, transcribed. Everything the two agree on is
	 * behaviour this refactor preserved; everything they disagree on is the fix, and the
	 * disagreement set is asserted exactly — not "at least these".
	 */
	const previousLabel = ({ state, runnerOnline, hasActiveSession }: RepoSignals) => {
		if (!hasActiveSession) return runnerOnline === false ? "Runner offline" : "Ready";
		if (isEngineBusy(state)) return "Working...";
		if (state === "idle") return "Ready";
		if (state === "offline") return "Runner offline";
		return "Active";
	};

	it("changes exactly the cells where a live session sat on an unreachable machine", () => {
		const changed: string[] = [];
		for (const state of STATES) {
			for (const runnerOnline of ONLINE) {
				for (const hasActiveSession of [true, false]) {
					const signals = { state, runnerOnline, hasActiveSession };
					if (repoStatusLabel(signals) !== previousLabel(signals)) {
						changed.push(`${String(state)}/${String(runnerOnline)}/${hasActiveSession}`);
					}
				}
			}
		}
		expect(changed.sort()).toEqual(["idle/false/true", "undefined/false/true"]);
	});
});

describe("wording is a rendering, not the rule", () => {
	it("every state has a phrase and a badge", () => {
		const states: RepoState[] = ["working", "offline", "active", "ready"];
		for (const s of states) {
			expect(repoStatusLabel({ state: s === "working" ? "thinking" : s, runnerOnline: true, hasActiveSession: true })).toBeTruthy();
			expect(sessionBadge(s).label).toBeTruthy();
		}
	});

	it("the badge collapses `active` and `ready` — 'Idle' is what both mean to a reader", () => {
		expect(sessionBadge("active")).toEqual(sessionBadge("ready"));
	});
});

describe("the terminal poll's busy signal is deliberately wider than the engine's", () => {
	it("runs at full rate while an instruction is in flight", () => {
		// The reply has not landed, so `runState` is still whatever it was before the send.
		// Waiting out a 6s passive tick before the pane starts moving reads as a hang.
		expect(terminalPollBusy({ state: "ready", sending: true, looping: false })).toBe(true);
	});

	it("runs at full rate while the Loop is driving", () => {
		expect(terminalPollBusy({ state: "ready", sending: false, looping: true })).toBe(true);
	});

	it("drops to the passive tier only when all three are quiet", () => {
		expect(terminalPollBusy({ state: "ready", sending: false, looping: false })).toBe(false);
		expect(terminalPollBusy({ state: "active", sending: false, looping: false })).toBe(false);
		// An offline runner is NOT a reason to hammer the relay 1.5s at a time.
		expect(terminalPollBusy({ state: "offline", sending: false, looping: false })).toBe(false);
	});

	it("runs at full rate whenever the engine is taking a turn", () => {
		expect(terminalPollBusy({ state: "working", sending: false, looping: false })).toBe(true);
	});
});
