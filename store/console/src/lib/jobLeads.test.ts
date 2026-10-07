import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canTriage, JOB_LEAD_TRANSITIONS, jobLeadStatus } from "./jobLeads";

describe("the Data tab's job-lead lifecycle (#955)", () => {
	it("is the server's transition table, read from its source", () => {
		const src = readFileSync(join(__dirname, "../../../../workers/api/src/lib/job-lead-triage.ts"), "utf8");
		const block = /export const JOB_LEAD_TRANSITIONS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
		const server = Object.fromEntries([...block.matchAll(/(\w+):\s*\[([^\]]*)\]/g)].map((m) => [m[1], [...m[2].matchAll(/"(\w+)"/g)].map((x) => x[1])]));
		expect(Object.keys(server).length, "parsed no transitions — the guard stopped measuring").toBeGreaterThanOrEqual(7);
		expect(JOB_LEAD_TRANSITIONS).toEqual(server);
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
