/**
 * A "repo busy" refusal names the run holding the repo and links to it (#931).
 *
 * The console showed only the refusal's sentence — written for agents, telling them to "stop it first
 * with stop_work", a tool no console button calls — with no way to see the blocking run. These hold
 * the pure half: reading the holder out of the refusal, and the link to its live view.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUSY_HOLD_STOPPING, busyHoldFrom, busyHoldLink, busyHoldNotice, busyHoldRunsLink, busyHoldStopPath } from "./coding-loop-run";

/** What the SDK's ApiError carries for `POST /loop` refused as busy (routes/tools.ts:1229-1230). */
const refusal = (extra: Record<string, unknown>) =>
	Object.assign(new Error("platform is already being worked on — wait for the current run to finish, or stop it first with stop_work."), {
		status: 409,
		body: { error: "…", reason: "busy", startState: "not_started", inFlightStarts: [], ...extra },
	});

const NOW = Date.UTC(2026, 9, 6, 9, 0);
const RUN = { runId: "run-1", objective: "Fix issue #48: flaky deploy", startedAt: NOW - 7 * 60_000, requestId: null, sessionId: "csess_abc" };

describe("busyHoldFrom", () => {
	it("reads the blocking run out of a busy refusal", () => {
		expect(busyHoldFrom(refusal({ activeRun: RUN }))).toEqual({
			run: { runId: "run-1", objective: "Fix issue #48: flaky deploy", startedAt: RUN.startedAt, sessionId: "csess_abc" },
			pendingStart: null,
		});
	});

	it("reports a start still being set up when no run holds the repo yet", () => {
		const hold = busyHoldFrom(refusal({ activeRun: null, inFlightStarts: [{ requestId: "r", objective: "Ship it", ageMs: 30_000 }] }));
		expect(hold).toEqual({ run: null, pendingStart: { objective: "Ship it", ageMs: 30_000 } });
	});

	it("is null for any other refusal, a bare Error, or a busy answer that names nothing", () => {
		expect(busyHoldFrom(Object.assign(new Error("x"), { body: { reason: "engine_auth", activeRun: RUN } }))).toBeNull();
		expect(busyHoldFrom(new Error("Runner offline"))).toBeNull();
		expect(busyHoldFrom(refusal({ activeRun: null }))).toBeNull();
		expect(busyHoldFrom(null)).toBeNull();
	});
});

describe("the link to the blocking run", () => {
	it("is its coding session's live view, as an in-router path (the router supplies /console)", () => {
		const hold = busyHoldFrom(refusal({ activeRun: RUN }))!;
		expect(busyHoldLink("inst-1", hold)).toBe("/instances/inst-1/coding/csess_abc");
		expect(busyHoldLink("inst-1", hold)).not.toMatch(/^\/console/);
	});

	it("escapes ids, so a value can never add path segments", () => {
		const hold = busyHoldFrom(refusal({ activeRun: { ...RUN, sessionId: "a/b?c" } }))!;
		expect(busyHoldLink("i/1", hold)).toBe("/instances/i%2F1/coding/a%2Fb%3Fc");
	});

	it("is null when the run has no session to open — the notice then offers only the runs list", () => {
		expect(busyHoldLink("inst-1", busyHoldFrom(refusal({ activeRun: { ...RUN, sessionId: null } }))!)).toBeNull();
		expect(busyHoldRunsLink("inst-1")).toBe("/instances/inst-1/settings");
	});
});

describe("stopping the blocking run from the notice", () => {
	it("cancels exactly that run, cooperatively — the same call every Stop button makes", () => {
		expect(busyHoldStopPath("inst-1", busyHoldFrom(refusal({ activeRun: RUN }))!)).toBe("/v1/instances/inst-1/loop/run-1/cancel");
	});

	it("has nothing to stop for a start that is still being set up", () => {
		expect(busyHoldStopPath("inst-1", { run: null, pendingStart: { objective: null, ageMs: 0 } })).toBeNull();
	});

	it("says the stop waits for the current step, not that the repo is free", () => {
		expect(BUSY_HOLD_STOPPING).toMatch(/current step finishes first/);
	});
});

describe("busyHoldNotice", () => {
	it("says what holds the repo and since when — never the agent-facing tool name", () => {
		const text = busyHoldNotice(busyHoldFrom(refusal({ activeRun: RUN }))!, NOW);
		expect(text).toContain("“Fix issue #48: flaky deploy”");
		expect(text).toContain("started 7 min ago");
		expect(text).not.toContain("stop_work");
	});

	it("marks a long objective as cut rather than cutting it silently", () => {
		const long = "x".repeat(300);
		const text = busyHoldNotice(busyHoldFrom(refusal({ activeRun: { ...RUN, objective: long } }))!, NOW);
		expect(text).toContain("…”");
		expect(text).not.toContain(long);
	});

	it("tells a pending start to be waited for, not repeated", () => {
		const text = busyHoldNotice({ run: null, pendingStart: { objective: "Ship it", ageMs: 45_000 } }, NOW);
		expect(text).toMatch(/still being set up \(requested just now\)\. Wait for it/);
	});
});

describe("the Coding tab catches a busy refusal as a hold, not a sentence", () => {
	const HOOK = readFileSync(join(__dirname, "use-coding-loop.ts"), "utf8");
	const VIEW = readFileSync(join(__dirname, "CopilotView.tsx"), "utf8");

	it("routes a busy refusal to the notice and keeps every other refusal's message", () => {
		expect(HOOK).toMatch(/const hold = busyHoldFrom\(e\);\s+if \(hold\) setBusyHold\(hold\);\s+else emitSystem\(loopStartFailureNotice\(e\)\);/);
	});

	it("renders the notice", () => {
		expect(VIEW).toContain("<BusyHoldNotice instanceId={instanceId} hold={loop.busyHold} onDismiss={loop.clearBusyHold} onQueue={loop.queueBehind} />");
	});
});
