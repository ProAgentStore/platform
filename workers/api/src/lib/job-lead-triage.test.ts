import { describe, expect, it } from "vitest";
import type { CollectionRecord } from "../agent-storage-types.js";
import { JOB_LEAD_APPLY_EVENT, JOB_LEAD_TRANSITIONS, duplicateApplyOf, jobIdentity, jobLeadStatus, planApplicationWriteback, planJobLeadTriage } from "./job-lead-triage.js";

const lead = (data: Record<string, unknown> = {}): CollectionRecord => ({
	id: "lead-1",
	collection: "job_leads",
	data: {
		title: "Head of Engineering",
		company: "Example",
		location: "Sydney",
		url: "https://example.test/job",
		source: "seek",
		posted_date: "2026-10-05",
		match_rationale: "AI leadership",
		// What must NEVER leave the lead (#955): contact details, notes, session state.
		contact_email: "recruiter@example.test",
		recruiter_phone: "+61 400 000 000",
		cookies: "session=abc",
		...data,
	},
	createdAt: "2026-10-07T00:00:00.000Z",
	updatedAt: "2026-10-07T00:00:00.000Z",
});
const at = "2026-10-07T01:00:00.000Z";
const plan = (r: CollectionRecord, input: Parameters<typeof planJobLeadTriage>[1] extends infer T ? Omit<T & object, "sourceInstanceId"> : never) =>
	planJobLeadTriage(r, { ...input, sourceInstanceId: "scout-1" }, { now: at });
/** The lead after a plan's patch was written. */
const after = (r: CollectionRecord, p: ReturnType<typeof planJobLeadTriage>) => {
	if (!p.ok || !p.patch) throw new Error("expected a transition");
	return { ...r, data: { ...r.data, ...p.patch } };
};

describe("Job lead triage lifecycle (#955)", () => {
	it("Apply emits the issue's envelope — and nothing outside it", () => {
		const p = plan(lead(), { action: "apply", note: "Strong match" });
		expect(p).toMatchObject({ ok: true, transitioned: true });
		if (!p.ok) throw new Error("expected plan");
		expect(p.event).toEqual({
			eventType: JOB_LEAD_APPLY_EVENT,
			eventId: "scout-1:lead-1:1",
			sourceInstanceId: "scout-1",
			leadId: "lead-1",
			leadUrl: "https://example.test/job",
			lifecycleVersion: 1,
			requestedAt: at,
			lead: { title: "Head of Engineering", company: "Example", location: "Sydney", url: "https://example.test/job", source: "seek", posted_date: "2026-10-05", match_rationale: "AI leadership" },
		});
		const wire = JSON.stringify(p.event);
		for (const secret of ["recruiter@example.test", "+61 400", "session=abc", "Strong match"]) expect(wire).not.toContain(secret);
	});

	it("writes the state, the version and an audit entry with the handoff, in one patch", () => {
		const p = plan(lead(), { action: "apply" });
		if (!p.ok) throw new Error("expected plan");
		expect(p.patch).toMatchObject({
			status: "apply_requested",
			lifecycle_version: 1,
			lifecycle: [{ from: "new", to: "apply_requested", action: "apply", version: 1, at }],
			apply_request_id: "scout-1:lead-1:1",
			apply_handoff: { eventId: "scout-1:lead-1:1" },
		});
	});

	it.each(["skip", "defer", "archive"] as const)("%s changes state, versions it, and emits no application event", (action) => {
		const p = plan(lead(), { action });
		expect(p).toMatchObject({ ok: true, transitioned: true, event: null });
		if (!p.ok) throw new Error("expected plan");
		expect(p.patch).toMatchObject({ lifecycle_version: 1 });
		expect(p.patch?.apply_handoff).toBeUndefined();
	});

	it("concurrent Apply clicks: the second, against the applied lead, returns the SAME event and no transition", () => {
		const first = plan(lead(), { action: "apply", expectedStatus: "new", expectedVersion: 0 });
		const applied = after(lead(), first);
		// The DO serialises the two; the second sees the first's write, and its CAS is about the state
		// it SAW — which the first click has already decided exactly as it asked.
		const second = plan(applied, { action: "apply", expectedStatus: "new", expectedVersion: 0 });
		expect(second).toMatchObject({ ok: true, transitioned: false });
		if (!first.ok || !second.ok) throw new Error("expected plans");
		expect(second.event?.eventId).toBe(first.event?.eventId);
	});

	it("a retry after an outbox failure re-delivers the stored handoff, unchanged by later edits", () => {
		const applied = after(lead(), plan(lead(), { action: "apply" }));
		const edited = { ...applied, data: { ...applied.data, company: "Renamed later" } };
		const retry = plan(edited, { action: "apply" });
		if (!retry.ok) throw new Error("expected plan");
		expect(retry).toMatchObject({ transitioned: false, event: { eventId: "scout-1:lead-1:1", lead: { company: "Example" } } });
	});

	it("rejects a stale action — on status or on version — rather than deciding on a state nobody saw", () => {
		const deferred = after(lead(), plan(lead(), { action: "defer" }));
		expect(plan(deferred, { action: "skip", expectedStatus: "new" })).toMatchObject({ ok: false, stale: true, error: expect.stringContaining("now deferred") });
		expect(plan(deferred, { action: "skip", expectedVersion: 0 })).toMatchObject({ ok: false, stale: true, error: expect.stringContaining("lifecycle version 1") });
		// The current state and version: accepted.
		expect(plan(deferred, { action: "skip", expectedStatus: "deferred", expectedVersion: 1 })).toMatchObject({ ok: true, transitioned: true });
	});

	it("follows the transition table — including apply_requested → archived, and nothing from archived", () => {
		const applied = after(lead(), plan(lead(), { action: "apply" }));
		const archived = plan(applied, { action: "archive" });
		expect(archived).toMatchObject({ ok: true, transitioned: true, event: null });
		expect(plan(applied, { action: "skip" })).toMatchObject({ ok: false, error: "Cannot skip a lead in apply_requested status." });
		expect(plan(lead({ status: "archived" }), { action: "apply" })).toEqual({ ok: false, error: "Cannot apply a lead in archived status." });
		expect(JOB_LEAD_TRANSITIONS.apply_requested).toEqual(["tailoring", "blocked", "archived"]);
	});

	it("reads a lead from before the lifecycle (`found`, or no status) as new, and its version as 0", () => {
		expect(jobLeadStatus({ status: "found" })).toBe("new");
		expect(jobLeadStatus({})).toBe("new");
		const p = plan(lead({ status: "found" }), { action: "apply", expectedStatus: "found", expectedVersion: 0 });
		expect(p).toMatchObject({ ok: true, transitioned: true, event: { lifecycleVersion: 1 } });
	});
});

describe("#953: one application per job, and its status on the lead", () => {
	const rec = (id: string, data: Record<string, unknown>) => ({ id, collection: "job_leads", data, createdAt: "x", updatedAt: "x" });

	it("knows two postings are the same job by job id, else by the URL without tracking, fragment or trailing slash", () => {
		expect(jobIdentity({ url: "https://Jobs.Example.com/a/?utm_source=x#apply" })).toBe(jobIdentity({ url: "https://jobs.example.com/a" }));
		expect(jobIdentity({ url: "https://jobs.example.com/a?id=1" })).not.toBe(jobIdentity({ url: "https://jobs.example.com/a?id=2" }));
		expect(jobIdentity({ job_id: 42, source: "Seek", url: "https://a" })).toBe(jobIdentity({ jobId: "42", source: "seek", url: "https://b" }));
		expect(jobIdentity({})).toBeNull();
	});

	it("finds only another lead of the same job that was already applied for", () => {
		const me = rec("l2", { url: "https://jobs.example.com/a?utm_medium=m" });
		expect(duplicateApplyOf(me, [rec("l1", { url: "https://jobs.example.com/a" })])).toBeNull();
		expect(duplicateApplyOf(me, [rec("l1", { url: "https://jobs.example.com/a", apply_request_id: "s:l1:1" })])).toBe("l1");
		expect(duplicateApplyOf(me, [rec("l2", { url: "https://jobs.example.com/a", apply_request_id: "s:l2:1" })])).toBeNull();
	});

	it("applies a writeback only when it is newer, and never touches the triage status", () => {
		const base = { applicationId: "a1", leadVersion: 1, status: "filling", version: 3, at: "t" };
		const lead = rec("l1", { status: "apply_requested", application_id: "a1", application_lead_version: 1, application_version: 3 });
		expect(planApplicationWriteback(lead, base)).toBeNull();
		expect(planApplicationWriteback(lead, { ...base, version: 2 })).toBeNull();
		expect(planApplicationWriteback(lead, { ...base, version: 4 })).toMatchObject({ application_status: "filling", application_version: 4 });
		expect(planApplicationWriteback(lead, { ...base, applicationId: "a2", leadVersion: 2, version: 0 })).toMatchObject({ application_id: "a2" });
		expect(planApplicationWriteback(lead, { ...base, version: 9 })).not.toHaveProperty("status");
	});
});
