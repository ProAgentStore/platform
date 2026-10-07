import { describe, expect, it } from "vitest";
import type { CollectionRecord } from "../agent-storage-types.js";
import { JOB_LEAD_APPLY_EVENT, planJobLeadTriage } from "./job-lead-triage.js";

const lead = (data: Record<string, unknown> = {}): CollectionRecord => ({
	id: "lead-1",
	collection: "job_leads",
	data: { title: "Head of Engineering", company: "Example", url: "https://example.test/job", ...data },
	createdAt: "2026-10-07T00:00:00.000Z",
	updatedAt: "2026-10-07T00:00:00.000Z",
});

describe("Job lead triage lifecycle", () => {
	it("only an explicit apply transition creates a stable application handoff", () => {
		const plan = planJobLeadTriage(lead(), { action: "apply", note: "Strong AI leadership match" }, {
			now: "2026-10-07T01:00:00.000Z",
			eventId: "apply-1",
		});
		expect(plan).toMatchObject({ ok: true, transitioned: true });
		if (!plan.ok) throw new Error("expected plan");
		expect(plan.patch).toMatchObject({ status: "apply_requested", apply_request_id: "apply-1" });
		expect(plan.event).toMatchObject({
			eventType: JOB_LEAD_APPLY_EVENT,
			eventId: "apply-1",
			lead: { id: "lead-1", data: { status: "apply_requested", title: "Head of Engineering" } },
		});
		expect((plan.event?.lead.data ?? {}).apply_handoff).toBeUndefined();
	});

	it.each(["skip", "defer", "archive"] as const)("%s changes state but emits no application event", (action) => {
		const plan = planJobLeadTriage(lead(), { action }, { now: "2026-10-07T01:00:00.000Z" });
		expect(plan).toMatchObject({ ok: true, transitioned: true, event: null });
		if (!plan.ok) throw new Error("expected plan");
		expect(plan.patch?.status).toBe(action === "skip" ? "skipped" : action === "defer" ? "deferred" : "archived");
	});

	it("repeating apply returns the original stable snapshot without another transition", () => {
		const first = planJobLeadTriage(lead(), { action: "apply" }, { now: "2026-10-07T01:00:00.000Z", eventId: "apply-1" });
		if (!first.ok || !first.patch) throw new Error("expected initial apply plan");
		const applied = lead({ ...lead().data, ...first.patch, company: "Changed later" });
		const retry = planJobLeadTriage(applied, { action: "apply" });
		expect(retry).toMatchObject({ ok: true, transitioned: false, event: { eventId: "apply-1" } });
		if (!retry.ok) throw new Error("expected retry plan");
		// The saved approval snapshot is immutable; unrelated later collection edits cannot change
		// an outbox identity and turn an idempotent retry into a second application request.
		expect(retry.event?.lead.data.company).toBe("Example");
	});

	it("refuses transition from an archived lead", () => {
		const plan = planJobLeadTriage(lead({ status: "archived" }), { action: "apply" });
		expect(plan).toEqual({ ok: false, error: "Cannot apply a lead in archived status." });
	});
});
