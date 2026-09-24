import { describe, expect, it } from "vitest";
import { trustedWebsiteBuilderEvidence } from "./website-builder-evidence.js";
import type { WebsiteBuilderJobCall } from "./website-builder-jobs.js";

const STATE = { fwsSessionId: "s1", noindexConfirmed: true, mcpUrl: "https://fws.example/mcp" };
const call = (tool: string, args: Record<string, unknown>, data: Record<string, unknown>, success = true): WebsiteBuilderJobCall => ({
	tool, args, success, result: JSON.stringify({ tool, ok: success, data }),
	metadata: { source: "pags.website_builder_broker", endpoint: STATE.mcpUrl, session_id: "s1" },
});

describe("trustedWebsiteBuilderEvidence", () => {
	const claim = { session_id: "s1", template_slug: "cafe", summary: "terminal prose is not evidence" };
	const good: WebsiteBuilderJobCall[] = [
		call("create_site", { template_slug: "cafe" }, { session_id: "s1", template_slug: "cafe" }),
		call("get_quality_report", { session_id: "s1" }, { ready_for_human_review: true, compliance: { failures: 0 } }),
		call("get_rendered_preview", { session_id: "s1" }, { preview_url: "https://fws.example/session/s1/preview" }),
		call("capture_preview", { session_id: "s1", viewport: "desktop" }, { session_id: "s1", viewport: "desktop", preview_url: "https://fws.example/session/s1/preview", mime_type: "image/jpeg", width: 1440, height: 900 }),
		call("capture_preview", { session_id: "s1", viewport: "mobile" }, { session_id: "s1", viewport: "mobile", preview_url: "https://fws.example/session/s1/preview", mime_type: "image/jpeg", width: 390, height: 844 }),
	];

	it("uses only broker-confirmed QA and preview URLs", () => {
		const evidence = trustedWebsiteBuilderEvidence(claim, good, STATE);
		expect(evidence).toMatchObject({ session_id: "s1", template_slug: "cafe", ready_for_human_review: true });
		expect(evidence?.desktop_preview).toBe("https://fws.example/session/s1/preview");
	});

	it("rejects a terminal claim unless every required broker result agrees", () => {
		expect(trustedWebsiteBuilderEvidence({ ...claim, session_id: "other" }, good, STATE)).toBeNull();
		expect(trustedWebsiteBuilderEvidence(claim, good.slice(0, -1), STATE)).toBeNull();
		expect(trustedWebsiteBuilderEvidence(claim, [
			...good.slice(0, 3),
			call("capture_preview", { session_id: "s1", viewport: "mobile" }, { session_id: "s1", viewport: "mobile", preview_url: "http://untrusted.example/preview", mime_type: "image/jpeg", width: 390, height: 844 }),
		], STATE)).toBeNull();
		expect(trustedWebsiteBuilderEvidence(claim, good, { ...STATE, noindexConfirmed: false })).toBeNull();
	});
});
