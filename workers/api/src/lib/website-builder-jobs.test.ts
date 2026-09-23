import { describe, expect, it } from "vitest";
import { WEBSITE_BUILDER_DRAFT_TOOLS, websiteBuilderToolAllowed, websiteBuilderToolInputAllowed } from "./website-builder-jobs.js";

describe("Website Builder job policy", () => {
	it("is an explicit draft allowlist, never a deploy denylist", () => {
		expect(websiteBuilderToolAllowed("create_site")).toBe(true);
		expect(websiteBuilderToolAllowed("capture_preview")).toBe(true);
		for (const tool of ["deploy", "publish", "push_update", "delete", "delete_site"]) expect(websiteBuilderToolAllowed(tool)).toBe(false);
		expect(WEBSITE_BUILDER_DRAFT_TOOLS.has("deploy")).toBe(false);
	});

	it("cannot remove noindex through the metadata tool", () => {
		expect(websiteBuilderToolInputAllowed("set_meta", { noindex: true })).toBe(true);
		expect(websiteBuilderToolInputAllowed("set_meta", { noindex: false })).toBe(false);
		expect(websiteBuilderToolInputAllowed("set_meta", {})).toBe(false);
	});
});
