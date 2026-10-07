/** MCP reply helpers. */
import { describe, expect, it } from "vitest";
import { chatReplyText } from "./http.js";

describe("chatReplyText (#898)", () => {
	it("returns a finished reply as is", () => {
		expect(chatReplyText({ message: { content: "All done." } })).toBe("All done.");
	});

	it("says a reply that hit the output cap is not the whole answer", () => {
		const out = chatReplyText({ message: { content: "Step 1… step 4. O" }, truncated: true, notice: "⚠️ cut off at the 4,096-token length limit" });
		expect(out.startsWith("Step 1… step 4. O")).toBe(true);
		expect(out).toMatch(/cut off at the 4,096-token length limit/);
	});

	it("still marks the cut when an older API sends the flag without its notice", () => {
		expect(chatReplyText({ message: { content: "x" }, truncated: true })).toMatch(/not the whole answer/);
	});
});
