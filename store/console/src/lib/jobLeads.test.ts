import { describe, expect, it } from "vitest";
import { canTriage, JOB_LEAD_TRANSITIONS, jobLeadStatus } from "./jobLeads";
import { JOB_LEAD_TRANSITIONS as serverTransitions } from "../../../../workers/api/src/lib/job-lead-triage";

describe("the Data tab's job-lead lifecycle (#955)", () => {
	it("is the server's transition contract", () => {
		expect(JOB_LEAD_TRANSITIONS).toEqual(serverTransitions);
	});

	it("enables exactly the actions the server accepts", () => {
		expect(canTriage("new", "apply")).toBe(true);
		expect(canTriage("apply_requested", "archive")).toBe(true);
		expect(canTriage("apply_requested", "skip")).toBe(false);
		expect(canTriage("archived", "apply")).toBe(false);
		expect(canTriage("skipped", "defer")).toBe(false);
	});

	it("reads a lead from before the lifecycle as new", () => {
		expect(jobLeadStatus({ status: "found" })).toBe("new");
		expect(jobLeadStatus({})).toBe("new");
		expect(jobLeadStatus({ status: "deferred" })).toBe("deferred");
	});
});
