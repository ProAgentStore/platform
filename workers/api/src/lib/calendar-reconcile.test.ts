/**
 * #1313 — the hiring safeguards. The incident: a FreeAppStore candidate interviewed on the Beta Builders
 * calendar was classified as BetaBuilders because of whose calendar it was. Calendar ownership, the event
 * title, the organiser and the meeting link must never decide a brand.
 */
import { describe, expect, it } from "vitest";
import { reconcileInterviewEvent } from "./calendar-reconcile.js";
import type { CalendarEvent } from "./google-calendar.js";

const EVENT: CalendarEvent = {
	calendarId: "betabuilders.org@gmail.com",
	eventId: "ev1",
	status: "confirmed",
	title: "BetaBuilders interview — Ada",
	organizer: { email: "betabuilders.org@gmail.com", displayName: "Beta Builders" },
	attendees: [{ email: "ada@example.com", displayName: "Ada", rsvp: "accepted", organizer: false, optional: false, resource: false }],
	attendeesOmitted: 0,
	start: { dateTime: "2026-10-25T10:00:00+11:00", date: null, timeZone: "Australia/Sydney" },
	end: { dateTime: "2026-10-25T10:30:00+11:00", date: null, timeZone: "Australia/Sydney" },
	joinUrl: "https://meet.google.com/abc",
	updated: "2026-10-20T01:02:03.000Z",
};
const FAS = { applicationId: "app-fas-1", workspace: "FreeAppStore", email: "ada@example.com" };
const BB = { applicationId: "app-bb-1", workspace: "BetaBuilders", email: "ada@example.com" };
const ok = { event: EVENT, candidateEmail: "ada@example.com", emailVerification: "ats_application_record", workspace: "FreeAppStore", workspaceBasis: "owner_instruction", applications: [FAS] };

describe("a match needs verified email, exact evidence and an explicit workspace (#1313)", () => {
	it("reconciles a FreeAppStore candidate on the Beta Builders calendar under FreeAppStore, with truthful evidence", () => {
		const r = reconcileInterviewEvent(ok);
		expect(r).toMatchObject({ decision: "matched", evidence: { calendarId: "betabuilders.org@gmail.com", eventId: "ev1", applicationId: "app-fas-1", workspace: "FreeAppStore", matchedOn: ["attendee"], eventUpdated: "2026-10-20T01:02:03.000Z" } });
		if (r.decision !== "matched") throw new Error("unreachable");
		// No outcome is invented: the evidence says an event was reconciled and nothing more.
		expect(r.evidence.note).toMatch(/No interview outcome is recorded or implied/);
		expect(JSON.stringify(r.evidence)).not.toMatch(/passed|rejected|hired|no.?show|completed/i);
	});

	it("refuses an unverified email, and an address read off the event is not verification", () => {
		for (const v of [undefined, "", "calendar_event", "attendee_list"]) expect(reconcileInterviewEvent({ ...ok, emailVerification: v })).toMatchObject({ decision: "refused", reason: expect.stringMatching(/must be verified/) });
		expect(reconcileInterviewEvent({ ...ok, candidateEmail: "ada" })).toMatchObject({ decision: "refused" });
	});

	it("refuses a missing workspace, and a basis that is the calendar, title, organiser or link", () => {
		expect(reconcileInterviewEvent({ ...ok, workspace: "  " })).toMatchObject({ decision: "refused", reason: expect.stringMatching(/selected explicitly/) });
		for (const basis of [undefined, "calendar_account", "event_title", "organizer", "meeting_link"]) {
			expect(reconcileInterviewEvent({ ...ok, workspaceBasis: basis })).toMatchObject({ decision: "refused", reason: expect.stringMatching(/never be calendar_account, event_title, organizer, meeting_link/) });
		}
	});

	it("matches nothing when the candidate is neither organiser nor attendee, however similar the address", () => {
		expect(reconcileInterviewEvent({ ...ok, candidateEmail: "da@example.com", applications: [{ ...FAS, email: "da@example.com" }] })).toMatchObject({ decision: "no_evidence" });
	});

	it("records an organiser match as such", () => {
		const e = { ...EVENT, organizer: { email: "ada@example.com", displayName: null }, attendees: [] };
		expect(reconcileInterviewEvent({ ...ok, event: e })).toMatchObject({ decision: "matched", evidence: { matchedOn: ["organizer"] } });
	});
});

describe("ambiguity is left to a person, never resolved by guessing (#1313)", () => {
	it("cross-brand: the email applied to another brand only, so nothing is attached", () => {
		const r = reconcileInterviewEvent({ ...ok, applications: [BB] });
		expect(r).toMatchObject({ decision: "needs_triage", reason: "cross_brand_ambiguity", candidates: [{ applicationId: "app-bb-1", workspace: "BetaBuilders" }] });
	});

	it("cross-brand: the same email in both brands, workspace chosen from the ATS record, is ambiguous", () => {
		expect(reconcileInterviewEvent({ ...ok, workspaceBasis: "ats_application_record", applications: [FAS, BB] })).toMatchObject({ decision: "needs_triage", reason: "cross_brand_ambiguity" });
	});

	it("cross-brand: the owner's explicit instruction settles it, and the other brand is reported", () => {
		const r = reconcileInterviewEvent({ ...ok, applications: [FAS, BB] });
		expect(r).toMatchObject({ decision: "matched", evidence: { applicationId: "app-fas-1", workspace: "FreeAppStore", otherWorkspaceMatches: 1 } });
	});

	it("several applications in the selected workspace: a person chooses", () => {
		const r = reconcileInterviewEvent({ ...ok, applications: [FAS, { ...FAS, applicationId: "app-fas-2" }] });
		expect(r).toMatchObject({ decision: "needs_triage", reason: "multiple_in_workspace" });
		if (r.decision !== "needs_triage") throw new Error("unreachable");
		expect(r.candidates.map((c) => c.applicationId).sort()).toEqual(["app-fas-1", "app-fas-2"]);
	});

	it("no application anywhere: nothing is created or matched", () => {
		expect(reconcileInterviewEvent({ ...ok, applications: [] })).toMatchObject({ decision: "needs_triage", reason: "none_in_workspace", candidates: [] });
	});

	it("ignores another candidate's applications and malformed rows", () => {
		const r = reconcileInterviewEvent({ ...ok, applications: [FAS, { applicationId: "x", workspace: "BetaBuilders", email: "bob@example.com" }, { applicationId: "", workspace: "FreeAppStore", email: "ada@example.com" }, {}] });
		expect(r).toMatchObject({ decision: "matched", evidence: { otherWorkspaceMatches: 0 } });
	});
});
