/**
 * Interview reconciliation safeguards (#1313): when may a calendar event be attached to a hiring
 * application, and when must a person decide?
 *
 * The incident behind this: the owner interviews candidates for several brands on ONE calendar
 * (`betabuilders.org@gmail.com`), and a FreeAppStore candidate was classified as BetaBuilders because
 * of whose calendar it was. Calendar ownership says nothing about the hiring organisation, so this
 * module never reads it — the decision is a pure function of five things the caller must state:
 *
 *   1. a candidate email, and the evidence it was VERIFIED (an application record, a mail thread, the
 *      candidate's own confirmation) — an address pulled off the event itself verifies nothing;
 *   2. the event's organiser or an attendee being exactly that email;
 *   3. an explicitly selected hiring workspace, with the basis for choosing it — never the calendar
 *      account, the event title, the organiser or the meeting link;
 *   4. the applications the ATS holds for that email across ALL workspaces, so ambiguity is visible;
 *   5. exactly one of those being in the selected workspace — and, when the same email also applied to
 *      other brands, the owner (not the ATS record) having chosen that workspace.
 *
 * Anything less is `needs_triage` (a person decides) or `refused` (the input is not enough to ask).
 * The platform holds no ATS: this module returns the evidence to append and never claims it wrote
 * to one, and it never invents an interview outcome.
 */
import { type CalendarEvent, eventInvolves, normalEmail } from "./google-calendar.js";

export const EMAIL_VERIFICATION_SOURCES = ["ats_application_record", "verified_mail_thread", "candidate_confirmed"] as const;
export const WORKSPACE_BASES = ["owner_instruction", "ats_application_record"] as const;
/** What a workspace must never be chosen from — named so a refusal can say what is forbidden. */
export const FORBIDDEN_WORKSPACE_BASES = ["calendar_account", "event_title", "organizer", "meeting_link"] as const;

export interface KnownApplication {
	applicationId: string;
	workspace: string;
	email: string;
}

export interface ReconcileRequest {
	event: CalendarEvent;
	candidateEmail: unknown;
	emailVerification: unknown;
	workspace: unknown;
	workspaceBasis: unknown;
	applications: readonly { applicationId?: unknown; workspace?: unknown; email?: unknown }[];
}

export type ReconcileDecision =
	| { decision: "refused"; reason: string }
	| { decision: "no_evidence"; reason: string }
	| { decision: "needs_triage"; reason: "multiple_in_workspace" | "none_in_workspace" | "cross_brand_ambiguity"; detail: string; candidates: Array<{ applicationId: string; workspace: string }> }
	| { decision: "matched"; evidence: ReconcileEvidence };

/** The record to append to the ATS: ids and facts only, no outcome. */
export interface ReconcileEvidence {
	calendarId: string;
	eventId: string;
	applicationId: string;
	workspace: string;
	candidateEmail: string;
	matchedOn: Array<"attendee" | "organizer">;
	emailVerification: string;
	workspaceBasis: string;
	eventUpdated: string | null;
	otherWorkspaceMatches: number;
	note: string;
}

const oneOf = <T extends string>(set: readonly T[], v: unknown): v is T => typeof v === "string" && (set as readonly string[]).includes(v);

export function reconcileInterviewEvent(req: ReconcileRequest): ReconcileDecision {
	const email = normalEmail(req.candidateEmail);
	if (!email) return { decision: "refused", reason: "candidate_email is required and must be a valid address." };
	if (!oneOf(EMAIL_VERIFICATION_SOURCES, req.emailVerification)) {
		return { decision: "refused", reason: `The candidate email must be verified, and email_verification must say how: one of ${EMAIL_VERIFICATION_SOURCES.join(", ")}. An address read off the calendar event is not verification.` };
	}
	const workspace = typeof req.workspace === "string" ? req.workspace.trim() : "";
	if (!workspace) return { decision: "refused", reason: "workspace is required: the hiring workspace must be selected explicitly. It is never inferred from the calendar, the event or the organiser." };
	if (!oneOf(WORKSPACE_BASES, req.workspaceBasis)) {
		return { decision: "refused", reason: `workspace_basis must say why that workspace was chosen: one of ${WORKSPACE_BASES.join(", ")}. It may never be ${FORBIDDEN_WORKSPACE_BASES.join(", ")}.` };
	}

	const involved = eventInvolves(req.event, email);
	if (!involved.attendee && !involved.organizer) {
		return { decision: "no_evidence", reason: "The candidate email is neither the organiser nor an attendee of this event, so it is not evidence about this candidate. Nothing was matched." };
	}

	const known: KnownApplication[] = req.applications.flatMap((a) => {
		const e = normalEmail(a.email);
		const applicationId = typeof a.applicationId === "string" ? a.applicationId.trim() : "";
		const ws = typeof a.workspace === "string" ? a.workspace.trim() : "";
		return e && applicationId && ws ? [{ applicationId, workspace: ws, email: e }] : [];
	});
	const forEmail = known.filter((a) => a.email === email);
	const inWorkspace = forEmail.filter((a) => a.workspace === workspace);
	const elsewhere = forEmail.filter((a) => a.workspace !== workspace);
	const list = (xs: KnownApplication[]) => xs.map(({ applicationId, workspace: w }) => ({ applicationId, workspace: w }));

	if (inWorkspace.length > 1) {
		return { decision: "needs_triage", reason: "multiple_in_workspace", detail: `${inWorkspace.length} applications for this email exist in workspace "${workspace}"; a person chooses.`, candidates: list(forEmail) };
	}
	if (inWorkspace.length === 0) {
		return elsewhere.length > 0
			? { decision: "needs_triage", reason: "cross_brand_ambiguity", detail: `No application for this email exists in the selected workspace "${workspace}", but ${elsewhere.length} exist in other workspaces. The event is not attached to any of them; a person decides.`, candidates: list(elsewhere) }
			: { decision: "needs_triage", reason: "none_in_workspace", detail: `No application for this email exists in workspace "${workspace}". Nothing was created or matched.`, candidates: [] };
	}
	// The same email applied to other brands too. An explicit instruction from the owner settles which
	// one; the ATS record cannot, because the ATS record is exactly what is ambiguous.
	if (elsewhere.length > 0 && req.workspaceBasis !== "owner_instruction") {
		return { decision: "needs_triage", reason: "cross_brand_ambiguity", detail: `This email has applications in ${elsewhere.length} other workspace(s) as well as "${workspace}", and the workspace was chosen from the ATS record rather than by the owner. A person decides.`, candidates: list(forEmail) };
	}
	const app = inWorkspace[0];
	return {
		decision: "matched",
		evidence: {
			calendarId: req.event.calendarId,
			eventId: req.event.eventId,
			applicationId: app.applicationId,
			workspace,
			candidateEmail: email,
			matchedOn: [...(involved.attendee ? (["attendee"] as const) : []), ...(involved.organizer ? (["organizer"] as const) : [])],
			emailVerification: req.emailVerification,
			workspaceBasis: req.workspaceBasis,
			eventUpdated: req.event.updated,
			otherWorkspaceMatches: elsewhere.length,
			note: "A calendar event for this candidate was reconciled to this application. No interview outcome is recorded or implied.",
		},
	};
}
