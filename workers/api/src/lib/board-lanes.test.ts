import { describe, expect, it } from "vitest";
import { BOARD_LANES, compareBacklog, issuePriority, laneFor, statusForIssueCard } from "./board-lanes.js";

const open = (labels: string[] = []) => ({ state: "open", labels });

describe("laneFor — where a card stands (#895)", () => {
	it("an open issue no run has touched is backlog; a closed one is done whatever its run said", () => {
		expect(laneFor({ issue: open(), status: "" })).toBe("backlog");
		expect(laneFor({ issue: { state: "closed", labels: [] }, run: { status: "failed" }, status: "" })).toBe("done");
	});

	it("a needs-person label parks an untouched issue — `isNeedsHumanLabel`'s own vocabulary", () => {
		for (const l of ["needs-human", "Needs Human", "blocked-on-serge", "human-only"]) expect(laneFor({ issue: open([l]), status: "" }), l).toBe("parked");
		expect(laneFor({ issue: open(["bug", "unblocked"]), status: "" })).toBe("backlog");
	});

	it("live work is never hidden behind a parked label", () => {
		expect(laneFor({ issue: open(["needs-human"]), run: { status: "running" }, status: "" })).toBe("running");
	});

	it("a run parked on a person — an answer, a takeover or a sign-in — is waiting on you; a usage-limit park is still running", () => {
		for (const w of ["decision", "human", "engine_auth"]) expect(laneFor({ issue: open(), run: { status: "running", waitingReason: w }, status: "" }), w).toBe("waiting_on_human");
		expect(laneFor({ issue: open(), run: { status: "running", waitingReason: "engine_limit" }, status: "" })).toBe("running");
		expect(laneFor({ issue: open(), run: { status: "needs_human" }, status: "" })).toBe("waiting_on_human");
	});

	it("a failed run on an open issue is failed; a completed run on a still-open issue is done only by status", () => {
		expect(laneFor({ issue: open(), run: { status: "failed" }, status: "" })).toBe("failed");
		expect(laneFor({ issue: open(), run: { status: "completed" }, status: "" })).toBe("done");
	});

	it("a card that is not an issue stands by its own status, and has no lane for a status the lanes have no word for", () => {
		expect(laneFor({ status: "queued" })).toBe("queued");
		expect(laneFor({ status: "needs_approval" })).toBe("queued");
		expect(laneFor({ status: "running" })).toBe("running");
		expect(laneFor({ status: "completed" })).toBe("done");
		expect(laneFor({ status: "failed" })).toBe("failed");
		expect(laneFor({ status: "cancelled" })).toBeNull();
		expect(laneFor({ status: "interview" })).toBeNull();
	});

	it("every lane a card can land in is a declared lane", () => {
		for (const lane of ["backlog", "parked", "queued", "running", "waiting_on_human", "failed", "done"]) expect(BOARD_LANES).toContain(lane);
	});
});

describe("backlog order", () => {
	it("reads P0/P1/priority/severity labels, and leaves an unlabelled issue last", () => {
		expect(issuePriority(["P0"])).toBe(0);
		expect(issuePriority(["priority: high"])).toBe(1);
		expect(issuePriority(["severity/medium"])).toBe(2);
		expect(issuePriority(["enhancement"])).toBe(4);
	});

	it("puts the most urgent first, then the oldest", () => {
		const issues = [
			{ number: 9, labels: [] },
			{ number: 12, labels: ["P1"] },
			{ number: 3, labels: [] },
			{ number: 20, labels: ["critical"] },
		];
		expect([...issues].sort(compareBacklog).map((i) => i.number)).toEqual([20, 12, 3, 9]);
	});
});

describe("statusForIssueCard — so an issue card still lands in the agent's ordinary columns", () => {
	it("maps each lane to a status the default columns place", () => {
		expect(statusForIssueCard("done", null)).toBe("completed");
		expect(statusForIssueCard("waiting_on_human", null)).toBe("needs_human");
		expect(statusForIssueCard("running", null)).toBe("running");
		expect(statusForIssueCard("failed", null)).toBe("failed");
		expect(statusForIssueCard("parked", null)).toBe("blocked");
		// Waiting, and pickable once a person releases it to the queue; parked never is.
		expect(statusForIssueCard("backlog", null)).toBe("queued");
	});
});
