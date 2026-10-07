import { describe, expect, it } from "vitest";
import { OLDER_HISTORY_NOTE, historyWindow } from "./history-window.js";

const note = (text: string) => `NOTE:${text}`;

describe("historyWindow (#898)", () => {
	it("leads the last `max` messages with a note when older ones exist", () => {
		const out = historyWindow(["m0", "m1", "m2", "m3"], 3, note);
		expect(out).toEqual([`NOTE:${OLDER_HISTORY_NOTE}`, "m1", "m2", "m3"]);
	});

	it("adds nothing when the window holds the whole conversation", () => {
		expect(historyWindow(["m0", "m1", "m2"], 3, note)).toEqual(["m0", "m1", "m2"]);
	});
});
