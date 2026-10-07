/**
 * The Applications tab's pure parts (#958): labels, and the one way an action request is built.
 * The SERVER decides which actions an item allows (`item.actions`) — this file never re-derives the
 * lifecycle, it only names things and sends the compare-and-set the item was read with.
 */
import type { ApplicationQueueAction, ApplicationQueueItem, ApplicationQueueStatus } from "./types";

type Tone = "accent" | "warning" | "success" | "danger" | "muted";

/** In queue order — the order the filter chips render in. */
export const QUEUE_STATUS_LABEL: Record<ApplicationQueueStatus, { label: string; tone: Tone }> = {
	new: { label: "New", tone: "accent" },
	apply_requested: { label: "Apply requested", tone: "accent" },
	tailoring: { label: "Tailoring", tone: "accent" },
	materials_ready: { label: "Materials ready", tone: "success" },
	filling: { label: "Filling", tone: "accent" },
	awaiting_review: { label: "Awaiting your review", tone: "warning" },
	submitted: { label: "Submitted", tone: "success" },
	blocked: { label: "Blocked", tone: "warning" },
	deferred: { label: "Deferred", tone: "muted" },
	skipped: { label: "Skipped", tone: "muted" },
	archived: { label: "Archived", tone: "muted" },
	failed: { label: "Failed", tone: "danger" },
};

export const ACTION_LABEL: Record<ApplicationQueueAction, string> = {
	apply: "Apply",
	skip: "Skip",
	defer: "Defer",
	archive: "Archive",
	generate_materials: "Tailor materials",
	retry_tailoring: "Retry tailoring",
	// The final-submit control: the server lists it ONLY when this application's policy allows an
	// automatic submit, and it says so on its face.
	start_fill: "Fill and submit (policy allows)",
	request_review: "Fill for review",
	retry_fill: "Retry fill",
	cancel: "Cancel",
	resume: "Resume",
	mark_not_interested: "Not interested",
};

/** Actions that change something outside PAGS records, and so ask before they run. */
export const CONFIRM: Partial<Record<ApplicationQueueAction, string>> = {
	start_fill: "Fill this application and SUBMIT it to the employer if the site accepts it? Your auto-submit policy allows it for this one.",
	cancel: "Stop the running tailoring or fill?",
};

/** The request for one action on one item — always with the status and version it was read in. */
export function actionBody(item: ApplicationQueueItem, action: ApplicationQueueAction, extra: { answers?: Array<{ question: string; answer: string }> } = {}): Record<string, unknown> {
	const target = item.applicationId
		? { application_id: item.applicationId, expected_version: item.stateVersion ?? undefined }
		: { scout_instance_id: item.scoutInstanceId, record_id: item.leadId, expected_version: item.leadVersion ?? undefined };
	return { action, expected_status: item.status, ...target, ...(extra.answers?.length ? { answers: extra.answers } : {}) };
}
