import { describe, expect, it } from "vitest";
import { applyPlace, dropPlace, neighbourPlace, objectiveCardKey, runQueueLabel } from "./boardOrder";

/** A board as the server lists it: two columns interleaved, in board order within each. */
const board = [
	{ jobKey: "w1", col: "waiting" },
	{ jobKey: "r1", col: "running" },
	{ jobKey: "w2", col: "waiting" },
	{ jobKey: "w3", col: "waiting" },
	{ jobKey: "r2", col: "running" },
];
const sameColumn = (a: { col: string }, b: { col: string }) => a.col === b.col;
const waiting = (items: typeof board) => items.filter((i) => i.col === "waiting").map((i) => i.jobKey);
const keys = (items: typeof board) => items.map((i) => i.jobKey);

describe("applyPlace (#1099) — predicts the server's order for the optimistic move", () => {
	it("to top puts the card first in ITS column and leaves the other column alone", () => {
		const out = applyPlace(board, "w3", { to: "top" }, sameColumn);
		expect(waiting(out)).toEqual(["w3", "w1", "w2"]);
		expect(out.filter((i) => i.col === "running").map((i) => i.jobKey)).toEqual(["r1", "r2"]);
	});

	it("to bottom puts it last in its column", () => {
		expect(waiting(applyPlace(board, "w1", { to: "bottom" }, sameColumn))).toEqual(["w2", "w3", "w1"]);
	});

	it("before / after a card in the same column", () => {
		expect(waiting(applyPlace(board, "w3", { before: "w2" }, sameColumn))).toEqual(["w1", "w3", "w2"]);
		expect(waiting(applyPlace(board, "w1", { after: "w3" }, sameColumn))).toEqual(["w2", "w3", "w1"]);
	});

	it("a reference in another column, or a card that is not there, changes nothing — the server says why", () => {
		expect(keys(applyPlace(board, "w1", { before: "r2" }, sameColumn))).toEqual(keys(board));
		expect(keys(applyPlace(board, "nope", { to: "top" }, sameColumn))).toEqual(keys(board));
		expect(keys(applyPlace(board, "w1", { after: "gone" }, sameColumn))).toEqual(keys(board));
	});

	it("does not mutate the board it was given (the snap-back restores that array)", () => {
		const copy = keys(board);
		applyPlace(board, "w3", { to: "top" }, sameColumn);
		expect(keys(board)).toEqual(copy);
	});
});

describe("neighbourPlace — Up and Down", () => {
	const column = [{ jobKey: "a" }, { jobKey: "b" }, { jobKey: "c" }];
	it("places against the neighbour in that direction", () => {
		expect(neighbourPlace(column, "b", "up")).toEqual({ before: "a" });
		expect(neighbourPlace(column, "b", "down")).toEqual({ after: "c" });
	});
	it("is null at the edge, so the control is disabled rather than a no-op request", () => {
		expect(neighbourPlace(column, "a", "up")).toBeNull();
		expect(neighbourPlace(column, "c", "down")).toBeNull();
		expect(neighbourPlace(column, "x", "up")).toBeNull();
	});
});

describe("dropPlace — where a dragged card lands", () => {
	it("before a card in its upper half, after it in its lower half", () => {
		const rect = { top: 100, height: 40 };
		expect(dropPlace("t", 110, rect)).toEqual({ before: "t" });
		expect(dropPlace("t", 130, rect)).toEqual({ after: "t" });
	});
});

describe("runQueueLabel — the Waiting card's marker", () => {
	it("marks the card that starts next, and the queued ones", () => {
		expect(runQueueLabel({ queue: "objective", next: true })).toEqual({ kind: "next", text: "Next to run" });
		expect(runQueueLabel({ queue: "ticket", next: false })?.kind).toBe("queued");
	});
	it("says why a Waiting card will never start by itself", () => {
		expect(runQueueLabel({ queue: null, reason: "human_authority" })).toEqual({ kind: "never", text: "Won't start by itself — a person has to release it to the queue" });
		expect(runQueueLabel({ queue: null, reason: "needs_approval" })?.text).toMatch(/approval/);
		expect(runQueueLabel({ queue: null, reason: "some_new_reason" })?.text).toMatch(/some new reason/);
	});
	it("is nothing off Waiting", () => {
		expect(runQueueLabel(undefined)).toBeNull();
	});
	it("a queued objective's card key", () => {
		expect(objectiveCardKey("objq-1")).toBe("objective:objq-1");
	});
});
