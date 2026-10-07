import { describe, expect, it } from "vitest";
import { clipMarked as apiClipMarked } from "../../api/src/lib/clip-marked.js";
import { clipMarked } from "./clip-marked.js";

describe("clipMarked — the MCP copy says what the API's says (#959)", () => {
	it("leaves short text whole and marks a cut with both lengths", () => {
		expect(clipMarked("short", 10)).toBe("short");
		expect(clipMarked("x".repeat(12), 5)).toBe("xxxxx\n[cut: showing the first 5 of 12 characters]");
	});

	it("is the API's head-cut, byte for byte — one rule across the Worker boundary", () => {
		for (const [text, max] of [["a".repeat(900), 500], ["éé" + "b".repeat(450), 400], ["fits", 400]] as const) {
			expect(clipMarked(text, max)).toBe(apiClipMarked(text, max));
		}
	});
});
