import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { WebsiteRequestCard } from "./WebsiteRequest";
import type { WebsiteAccessRequest } from "../lib/websiteAccess";

const request: WebsiteAccessRequest = { id: "question", instanceId: "agent", instanceName: "Job agent", hostname: "login.example.com", subjectKind: "local_apply_run", subjectId: "run", subjectLink: "/console/instances/agent/applications?run=run", status: "pending", createdAt: "2026-11-04T00:00:00Z", decidedAt: null, link: "/console/instances/agent/website-requests/question" };
const render = (status: WebsiteAccessRequest["status"], current = true) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(WebsiteRequestCard, { data: { request: { ...request, status }, current }, busy: false, error: "", message: "", onAnswer: () => undefined })));
describe("website owner question", () => {
	it("names the exact agent, host and originating run with explicit choices", () => {
		const html = render("pending");
		for (const text of ["Job agent", "login.example.com", "View originating run", "Allow and remember", "Deny", "exact hostname"]) expect(html).toContain(text);
		expect(html).not.toContain("local_apply_run");
	});
	it("keeps a stale question useful for future permission without restarting its run", () => {
		const html = render("pending", false);
		expect(html).toContain("will not restart the run");
		expect(html).toContain("Allow and remember");
	});
	it.each(["approved", "denied"] as const)("an answered %s request does not offer another decision", (status) => {
		const html = render(status);
		expect(html).not.toContain("<button");
		expect(html).toContain(status === "approved" ? "This request was allowed" : "This request was denied");
	});
});
