import { describe, expect, it } from "vitest";
import { parseWebsiteBuilderEvidence, WEBSITE_BUILDER_EVIDENCE_MARKER, websiteBuilderPrompt } from "./website-builder.js";

describe("Website Builder worker protocol", () => {
	const input = { taskId: "t1", instanceId: "i1", engine: "codex" as const, lead: { name: "Palm Tree Kiosk" }, brokerUrl: "https://api.example/jobs/t1/call", jobToken: "secret" };

	it("keeps FWS credentials out of the prompt and forbids deploy", () => {
		const prompt = websiteBuilderPrompt(input);
		expect(prompt).toContain("never call deploy");
		expect(prompt).toContain("PAGS_WEBSITE_BUILDER_TOKEN");
		expect(prompt).not.toContain(input.jobToken);
		expect(prompt).not.toContain("FWS OAuth credential");
	});

	it("accepts only complete tagged evidence", () => {
		const good = `${WEBSITE_BUILDER_EVIDENCE_MARKER}{"session_id":"s1","template_slug":"cafe","quality_report":{},"desktop_preview":"https://x/d","mobile_preview":"https://x/m","ready_for_human_review":true}`;
		expect(parseWebsiteBuilderEvidence(good)?.session_id).toBe("s1");
		expect(parseWebsiteBuilderEvidence(`${WEBSITE_BUILDER_EVIDENCE_MARKER}{"session_id":"s1"}`)).toBeNull();
	});
});
