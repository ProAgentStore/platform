/**
 * #1245 — `platform_guide` carries the label vocabulary, and it is the API worker's text: this worker
 * cannot import that one, so the copy is held to it here.
 */
import { describe, expect, it } from "vitest";
import { LABEL_GUIDANCE, LABEL_LIST_FORMAT, LABEL_VOCABULARY } from "./label-guidance.js";
import { PLATFORM_GUIDE } from "./platform-guide.js";

describe("the label guidance copy (#1245)", () => {
	it("is word for word the API worker's vocabulary and list format", async () => {
		const api = await import("../../api/src/lib/label-vocabulary.js");
		expect(LABEL_VOCABULARY).toBe(api.LABEL_VOCABULARY);
		expect(LABEL_LIST_FORMAT).toBe(api.LABEL_LIST_FORMAT);
	});

	it("platform_guide names the three tools that set labels, the vocabulary, and the string format", () => {
		expect(PLATFORM_GUIDE).toContain(LABEL_GUIDANCE);
		for (const tool of ["github_create_issue", "github_update_issue", "github_list_issues", "call_instance_tool"]) expect(LABEL_GUIDANCE).toContain(tool);
		expect(LABEL_GUIDANCE).toContain("`needs-human`");
		expect(LABEL_GUIDANCE).toContain("`P0` (wrong today)");
		expect(LABEL_GUIDANCE).toMatch(/comma-separated STRING/);
	});
});
