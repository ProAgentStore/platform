import { describe, it, expect } from "vitest";
import { activityBusy, boardBusy, isRunningCommand, terminalsBusy, tmuxBusy, ACTIVITY_BUSY_WINDOW_MS } from "./pollBusy";

const NOW = Date.parse("2026-08-06T12:00:00.000Z");
const agoIso = (ms: number) => new Date(NOW - ms).toISOString();

describe("boardBusy", () => {
	it("is busy while a job is running or queued", () => {
		// These advance on their own — the board must not slow down under work in flight.
		expect(boardBusy([{ status: "completed" }, { status: "running" }])).toBe(true);
		expect(boardBusy([{ status: "queued" }])).toBe(true);
	});

	it("is idle when every card is in a settled state", () => {
		// The case worth slowing down, and the case ~all of the time.
		expect(boardBusy([{ status: "completed" }, { status: "failed" }, { status: "cancelled" }])).toBe(false);
	});

	it("does not count a card that is waiting on the human", () => {
		// needs_human/needs_approval change only when a person acts, and a person acting on
		// the board is looking at it. Counting them as busy would pin the fastest poll in the
		// console to a card that can sit there for a week.
		expect(boardBusy([{ status: "needs_human" }, { status: "needs_approval" }, { status: "blocked" }])).toBe(false);
	});

	it("survives an empty or missing board", () => {
		expect(boardBusy([])).toBe(false);
		expect(boardBusy(undefined)).toBe(false);
		expect(boardBusy([{}])).toBe(false);
	});
});

describe("activityBusy", () => {
	it("is busy while events are still landing", () => {
		expect(activityBusy([{ createdAt: agoIso(2_000) }], NOW)).toBe(true);
	});

	it("goes idle once the agent has been quiet for the whole window", () => {
		expect(activityBusy([{ createdAt: agoIso(ACTIVITY_BUSY_WINDOW_MS + 1) }], NOW)).toBe(false);
	});

	it("reads the newest event, not the first one in the array", () => {
		// The log is rendered newest-first but nothing in the type guarantees the order, and
		// scanning only [0] would have called a live agent idle after one out-of-order row.
		expect(activityBusy([{ createdAt: agoIso(600_000) }, { createdAt: agoIso(1_000) }], NOW)).toBe(true);
	});

	it("ignores a timestamp it cannot parse instead of treating it as now", () => {
		// A single bad row would otherwise pin the tab to its fastest tier forever.
		expect(activityBusy([{ createdAt: "not a date" }, { createdAt: undefined }, {}], NOW)).toBe(false);
	});

	it("tolerates small clock skew but not a nonsense future stamp", () => {
		expect(activityBusy([{ createdAt: agoIso(-2_000) }], NOW)).toBe(true);
		expect(activityBusy([{ createdAt: "3000-01-01T00:00:00.000Z" }], NOW)).toBe(false);
	});

	it("survives an empty or missing log", () => {
		expect(activityBusy([], NOW)).toBe(false);
		expect(activityBusy(undefined, NOW)).toBe(false);
	});
});

describe("terminalsBusy", () => {
	it("is busy while any machine is believed offline", () => {
		// #241: backing off while we believe something is offline is how an offline state
		// becomes unrecoverable — that is the exact state the user is fixing with `pags up`.
		expect(terminalsBusy([{ connected: true }, { connected: false }])).toBe(true);
	});

	it("is busy with no machines at all", () => {
		// Same judgement: "No terminals connected" is watched by someone about to connect one.
		expect(terminalsBusy([])).toBe(true);
		expect(terminalsBusy(undefined)).toBe(true);
	});

	it("is busy while a coding session is active", () => {
		expect(terminalsBusy([{ connected: true, sessions: [{ status: "active" }] }])).toBe(true);
	});

	it("is idle when every machine is connected and nothing is running", () => {
		// A settled fleet is a boolean that changes about twice a day.
		expect(terminalsBusy([{ connected: true, sessions: [{ status: "ended" }] }, { connected: true, sessions: [] }])).toBe(false);
	});

	it("treats a missing `connected` as offline rather than online", () => {
		// The header dot shipped exactly this bug the other way round (#190): a falsy field
		// read as "online" kept a dead runner green.
		expect(terminalsBusy([{}])).toBe(true);
	});
});

describe("isRunningCommand", () => {
	it("does not count a pane sitting at a shell prompt", () => {
		for (const shell of ["zsh", "-zsh", "bash", "-bash", "fish", "/bin/zsh", "tmux"]) {
			expect(isRunningCommand(shell)).toBe(false);
		}
	});

	it("counts a real command", () => {
		expect(isRunningCommand("pnpm")).toBe(true);
		expect(isRunningCommand("node")).toBe(true);
		expect(isRunningCommand("/usr/local/bin/claude")).toBe(true);
	});

	it("counts nothing when the field is absent", () => {
		expect(isRunningCommand(undefined)).toBe(false);
		expect(isRunningCommand("  ")).toBe(false);
	});
});

describe("tmuxBusy", () => {
	it("is busy while a pane is running something", () => {
		expect(tmuxBusy([{ activeCommand: "zsh" }, { activeCommand: "pnpm" }])).toBe(true);
	});

	it("is idle when every pane is at a prompt", () => {
		expect(tmuxBusy([{ activeCommand: "zsh" }, { activeCommand: "-bash" }])).toBe(false);
	});

	it("is busy while the last refresh failed", () => {
		// The tool call only fails because the runner could not be reached. Backing off then
		// leaves the error on screen long after the machine came back.
		expect(tmuxBusy([], true)).toBe(true);
		expect(tmuxBusy(undefined, true)).toBe(true);
	});

	it("is idle with no targets and no error", () => {
		expect(tmuxBusy([])).toBe(false);
	});
});
