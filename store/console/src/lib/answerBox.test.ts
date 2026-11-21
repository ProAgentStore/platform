/** #1338 — the owner's free-text answer box: tall enough to read and edit, growing with its content, capped so Send stays reachable. */
import { describe, expect, it } from "vitest";
import { ANSWER_MAX_VIEWPORT_SHARE, ANSWER_MIN_PX, ANSWER_MIN_ROWS, answerBoxHeight } from "./answerBox";

describe("answerBoxHeight", () => {
	it("is never shorter than the comfortable minimum, however little is typed", () => {
		expect(ANSWER_MIN_ROWS).toBeGreaterThanOrEqual(4);
		expect(ANSWER_MIN_PX).toBeGreaterThanOrEqual(100);
		expect(answerBoxHeight(0, 800)).toBe(ANSWER_MIN_PX);
		expect(answerBoxHeight(30, 800)).toBe(ANSWER_MIN_PX);
	});

	it("grows with the content, line by line, until it reaches the cap", () => {
		expect(answerBoxHeight(200, 800)).toBe(200);
		expect(answerBoxHeight(300, 800)).toBe(300);
		expect(answerBoxHeight(400, 800)).toBe(Math.round(800 * ANSWER_MAX_VIEWPORT_SHARE)); // 360: capped, the box scrolls inside from here
	});

	it("caps at a share of the VISIBLE viewport, so an open phone keyboard leaves Send reachable", () => {
		// 844px tall phone, keyboard closed vs open (visualViewport shrinks to ~420px).
		expect(answerBoxHeight(1000, 844)).toBe(380);
		expect(answerBoxHeight(1000, 420)).toBe(189);
		// A very short viewport never squeezes the box below its minimum — it scrolls the page instead.
		expect(answerBoxHeight(1000, 200)).toBe(ANSWER_MIN_PX);
	});

	it("treats a missing or nonsense measurement as 'empty', never NaN or negative", () => {
		for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY]) expect(answerBoxHeight(bad, 800)).toBe(ANSWER_MIN_PX);
		expect(answerBoxHeight(500, Number.NaN)).toBe(ANSWER_MIN_PX);
	});
});
