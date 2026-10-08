import { describe, expect, it } from "vitest";
import { GMAIL_SCOUT_CAPABILITY, GMAIL_SCOUT_TOOLS } from "../config.js";

describe("Gmail Scout permissions", () => {
	it("declares exactly the two read tools and no mail mutation capability", () => {
		expect(GMAIL_SCOUT_CAPABILITY.readOnly).toBe(true);
		expect(GMAIL_SCOUT_TOOLS).toEqual(["gmail_search", "gmail_read_message"]);
		expect(GMAIL_SCOUT_TOOLS).not.toContain("gmail_send" as never);
		expect(GMAIL_SCOUT_TOOLS).not.toContain("gmail_modify" as never);
	});
});
