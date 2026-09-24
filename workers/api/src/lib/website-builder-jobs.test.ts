import { describe, expect, it } from "vitest";
import { WEBSITE_BUILDER_DRAFT_TOOLS, websiteBuilderTokenActive, websiteBuilderToolAllowed, websiteBuilderToolInputAllowed, type WebsiteBuilderJob } from "./website-builder-jobs.js";

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

	it("fails closed when a task token has expired or been revoked", () => {
		const job = (extra: Partial<WebsiteBuilderJob> = {}): WebsiteBuilderJob => ({
			id: "j", instanceId: "i", userId: "u", mcpUrl: "https://fws.example/mcp", tokenHash: "hash", status: "running", evidence: null,
			tokenExpiresAt: "2099-01-01 00:00:00", tokenRevokedAt: null, fwsSessionId: null, createStartedAt: null, noindexConfirmed: false, ...extra,
		});
		expect(websiteBuilderTokenActive(job())).toBe(true);
		expect(websiteBuilderTokenActive(job({ tokenExpiresAt: "2000-01-01 00:00:00" }))).toBe(false);
		expect(websiteBuilderTokenActive(job({ tokenRevokedAt: "2026-01-01 00:00:00" }))).toBe(false);
		expect(websiteBuilderTokenActive(job({ tokenExpiresAt: null }))).toBe(false);
	});
});
