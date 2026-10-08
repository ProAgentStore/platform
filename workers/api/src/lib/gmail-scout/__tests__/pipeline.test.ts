import { describe, expect, it } from "vitest";
import { planJobLeadTriage } from "../../job-lead-triage.js";

describe("approved Gmail lead handoff", () => {
	it("starts new and only explicit apply produces the durable Tailor handoff", () => {
		const record = { id: "lead-1", collection: "job_leads", createdAt: "x", updatedAt: "x", data: { title: "Engineer", url: "https://jobs.example.com/1", source: "Gmail (jobs.example.com)", status: "new" } };
		const applied = planJobLeadTriage(record, { action: "apply", sourceInstanceId: "scout-1" }, { now: "2026-10-09T00:00:00Z" });
		expect(applied).toMatchObject({ ok: true, event: { eventType: "job.lead.apply_requested", sourceInstanceId: "scout-1", leadId: "lead-1" } });
	});
});
