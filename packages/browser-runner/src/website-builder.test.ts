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

	it("accepts only a narrow tagged session claim, not terminal QA or URLs", () => {
		const good = `${WEBSITE_BUILDER_EVIDENCE_MARKER}{"session_id":"s1","template_slug":"cafe","desktop_preview":"https://attacker.example/d","ready_for_human_review":true}`;
		expect(parseWebsiteBuilderEvidence(good)?.session_id).toBe("s1");
		expect(parseWebsiteBuilderEvidence(`${WEBSITE_BUILDER_EVIDENCE_MARKER}{"session_id":"s1"}`)).toBeNull();
	});

	it("tells a resumed worker to edit its broker-confirmed session rather than create another", () => {
		const prompt = websiteBuilderPrompt({ ...input, existingSessionId: "fws_session_1" });
		expect(prompt).toContain("fws_session_1");
		expect(prompt).toContain("Do not call create_site again");
	});
});
