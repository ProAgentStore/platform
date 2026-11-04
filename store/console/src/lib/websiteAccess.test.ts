import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@proagentstore/sdk/client";
import { answerWebsiteRequest, getWebsiteRequest, parseWebsiteDomains, revokeWebsiteGrant, websiteAnswerMessage, websiteSubjectPath, type WebsiteAnswerResponse } from "./websiteAccess";
import { browserCapabilitiesPatch } from "./browserSettings";

vi.mock("@proagentstore/sdk/client", () => ({ api: vi.fn().mockResolvedValue({}) }));
beforeEach(() => vi.clearAllMocks());

describe("exact website choices", () => {
	it("normalizes and deduplicates exact hosts without merging subdomains", () => {
		expect(parseWebsiteDomains("Example.COM\nlogin.example.com, example.com.")).toEqual(["example.com", "login.example.com"]);
		expect(parseWebsiteDomains("")).toEqual([]);
	});
	it.each(["*.example.com", "https://example.com", "example.com/path", "example.com:443", "user@example.com", "example.com?token=x", "a..example.com", "-bad.example.com"])("rejects an ambiguous permission %s", (value) => {
		expect(() => parseWebsiteDomains(value)).toThrow();
	});
	it("bounds the list and maps only the changed capability", () => {
		expect(() => parseWebsiteDomains(Array.from({ length: 101 }, (_, i) => `site${i}.example.com`).join("\n"))).toThrow(/100/);
		expect(browserCapabilitiesPatch({ websiteAccess: { mode: "ask_once", domains: [] } })).toEqual({ browserWebsiteAccess: { mode: "ask_once", domains: [] } });
		expect(browserCapabilitiesPatch({ websiteAccess: null })).toEqual({ browserWebsiteAccess: null });
	});
});

describe("owner question API boundary", () => {
	it("reads inertly and records an answer only through the explicit POST", async () => {
		await getWebsiteRequest("agent/id", "question/id");
		expect(api).toHaveBeenLastCalledWith("/v1/instances/agent%2Fid/website-requests/question%2Fid");
		await answerWebsiteRequest("agent/id", "question/id", "deny");
		expect(api).toHaveBeenLastCalledWith("/v1/instances/agent%2Fid/website-requests/question%2Fid/answer", { method: "POST", body: '{"decision":"deny"}' });
		await revokeWebsiteGrant("agent/id", "login.example.com");
		expect(api).toHaveBeenLastCalledWith("/v1/instances/agent%2Fid/website-grants/login.example.com", { method: "DELETE" });
	});
	it("does not promote saved permission to a resumed run", () => {
		const response = { request: { status: "approved" }, recorded: true, resumed: false, resumeError: "The original run ended." } as WebsiteAnswerResponse;
		expect(websiteAnswerMessage(response)).toBe("Website remembered. The run has not resumed. The original run ended.");
		expect(websiteAnswerMessage({ ...response, repeated: true })).toContain("already answered. No run was resumed");
		expect(websiteAnswerMessage({ ...response, resumed: true })).toBe("Website remembered. The run has resumed.");
		expect(websiteAnswerMessage({ ...response, request: { ...response.request, status: "denied" } })).toContain("Access denied and remembered");
	});
	it("keeps originating links in the console instance router", () => {
		expect(websiteSubjectPath("/console/instances/agent/tasks/run")).toBe("/instances/agent/tasks/run");
		expect(websiteSubjectPath("https://console.proagentstore.online/instances/agent/applications?run=one")).toBe("/instances/agent/applications?run=one");
		for (const link of ["javascript:alert(1)", "//attacker.example/instances/a", "https://attacker.example/instances/a", "https://user:pass@console.proagentstore.online/instances/a", "/preferences"]) expect(websiteSubjectPath(link)).toBeNull();
	});
	it("reports other waiting tasks without claiming the original run resumed", () => {
		const response = { request: { status: "approved" }, recorded: true, resumed: false, additionalWaitingTasks: { continued: 2, denied: 0, failed: 1 } } as WebsiteAnswerResponse;
		expect(websiteAnswerMessage(response)).toContain("The run has not resumed.");
		expect(websiteAnswerMessage(response)).toContain("Other waiting tasks: 2 continued, 1 could not be updated.");
		expect(websiteAnswerMessage({ ...response, additionalWaitingTasks: { continued: 0, denied: 0, failed: 0 } })).not.toContain("Other waiting tasks:");
		expect(websiteAnswerMessage({ ...response, additionalWaitingTasksError: "Check their current statuses." })).toContain("Check their current statuses.");
	});
});
