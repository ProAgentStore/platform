import { describe, expect, it } from "vitest";
import { parseBrowserWebsiteAccess, refreshWebsiteAccess, websiteAccessBlock, websiteDecision } from "./browser-website-access.js";

describe("explicit website access policy", () => {
	it("absence retains legacy behavior while explicit malformed policy is refused", () => {
		expect(parseBrowserWebsiteAccess(undefined)).toBeUndefined();
		for (const raw of [null, {}, { mode: "all", domains: [] }, { mode: "allow_all" }, { mode: "ask_once", domains: ["https://example.test"] }, { mode: "allowlist", domains: ["*.example.test"] }]) expect(() => parseBrowserWebsiteAccess(raw)).toThrow();
	});
	it("normalizes configured and remembered exact hostnames", () => {
		expect(parseBrowserWebsiteAccess({ mode: "ask_once", domains: [" EXAMPLE.TEST. ", "example.test"], rememberedDomains: ["JOBS.EXAMPLE.TEST"], deniedDomains: ["NO.EXAMPLE.TEST"] })).toEqual({ mode: "ask_once", domains: ["example.test"], rememberedDomains: ["jobs.example.test"], deniedDomains: ["no.example.test"] });
	});
	it("allow_all ignores domain lists and remembered denials for every HTTP(S) host", () => {
		const policy = { mode: "allow_all" as const, domains: [], deniedDomains: ["example.test"] };
		for (const url of ["https://example.test", "https://another.test", "http://localhost", "http://127.0.0.1"]) expect(websiteAccessBlock(policy, url)).toBeNull();
	});
	it("strict allowlist permits only listed exact hosts, regardless of remembered decisions", () => {
		const policy = { mode: "allowlist" as const, domains: ["example.test"], rememberedDomains: ["other.test"] };
		expect(websiteDecision(policy, "example.test")).toBe("allow");
		for (const host of ["child.example.test", "other.test", "example.test.evil.test"]) expect(websiteDecision(policy, host)).toBe("deny");
		expect(websiteDecision({ mode: "allowlist", domains: [] }, "example.test")).toBe("deny");
	});
	it("ask_once honors exact remembered allow/deny and explicit configured overrides", () => {
		const policy = { mode: "ask_once" as const, domains: ["override.test"], rememberedDomains: ["yes.test", "no.test"], deniedDomains: ["no.test", "override.test"] };
		expect(websiteDecision(policy, "yes.test")).toBe("allow");
		expect(websiteDecision(policy, "no.test")).toBe("deny");
		expect(websiteDecision(policy, "override.test")).toBe("allow");
		for (const host of ["unknown.test", "child.yes.test"]) expect(websiteDecision(policy, host)).toBe("ask");
	});
	it("blocked metadata distinguishes a dispatched redirect and excludes URL credentials/query/fragment", () => {
		expect(websiteAccessBlock({ mode: "ask_once", domains: [] }, "https://user:secret@example.test/apply?token=secret#private", true)).toEqual({ decision: "ask", hostname: "example.test", url: "https://example.test/apply", mode: "ask_once", actionDispatched: true });
	});
	it("allows refreshed durable decisions but refuses a weaker mode/list on an existing task", () => {
		const frozen = { mode: "ask_once" as const, domains: ["example.test"] };
		expect(refreshWebsiteAccess(frozen, undefined)).toBe(frozen);
		expect(refreshWebsiteAccess(frozen, { ...frozen, rememberedDomains: ["approved.test"] })).toMatchObject({ rememberedDomains: ["approved.test"] });
		expect(refreshWebsiteAccess({ ...frozen, rememberedDomains: ["approved.test"] }, frozen)).toEqual(frozen);
		expect(() => refreshWebsiteAccess(frozen, { mode: "allow_all", domains: [] })).toThrow(/fixed/);
		expect(() => refreshWebsiteAccess(frozen, { ...frozen, domains: ["widened.test"] })).toThrow(/fixed/);
	});
});
