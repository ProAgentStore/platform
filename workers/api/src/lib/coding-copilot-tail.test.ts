/** The Co-pilot's terminal tail marks its cut (#898). */
import { describe, expect, it } from "vitest";
import { terminalTail } from "./coding-copilot.js";

describe("terminalTail", () => {
	it("keeps the last 6,000 characters and says how many there were", () => {
		const out = terminalTail(`${"a".repeat(10_000)}END`);
		expect(out.startsWith("[cut: showing the last 6000 of 10003 characters]\n")).toBe(true);
		expect(out.endsWith("END")).toBe(true);
	});

	it("passes a short pane through", () => {
		expect(terminalTail("❯ ok")).toBe("❯ ok");
	});
});
