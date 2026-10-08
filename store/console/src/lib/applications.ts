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
	// #973: the owner's decision about THIS job. Named for what it does, and distinct from
	// `start_fill` — that one reads a standing policy, this one IS the authorization.
	approve_and_proceed: "Approve & proceed",
};

/**
 * The same decision has two names, because by then it is two different acts (#981).
 *
 * Before the fill it PROCEEDS: nothing exists yet and approving dispatches the run. After the fill
 * it CONTINUES: the run has stopped and the owner decides whether it may be sent — either because
 * the form is filled and waiting (`awaiting_review`, a supervisor checkpoint) or because the run hit
 * a control it may not press under fill-and-review and ended `blocked` (#991). The server offers
 * `approve_and_proceed` pre-fill only on `materials_ready`, so the status is all it takes to
 * tell them apart — and the action name stays one name, which is what keeps this surface, the board
 * and MCP exposing exactly the same permitted action.
 */
export const actionLabel = (action: ApplicationQueueAction, status?: string): string =>
	action === "approve_and_proceed" && status && status !== "materials_ready" ? "Approve & continue" : ACTION_LABEL[action];

/** Actions that change something outside PAGS records, and so ask before they run. */
export const CONFIRM: Partial<Record<ApplicationQueueAction, string>> = {
	start_fill: "Fill this application and SUBMIT it to the employer if the site accepts it? Your auto-submit policy allows it for this one.",
	// The authorization is single-use, so the confirmation says what the owner is spending it on.
	approve_and_proceed: "Approve THIS application and submit it to the employer? The approval covers this one job only, is used once, and does not enable auto-submit for anything else.",
	cancel: "Stop the running tailoring or fill?",
};

/**
 * The post-fill wording (#981), true in both of the states that reach it (#991).
 *
 * It used to say "this FILLED application", which the one-click case makes false: the run reached a
 * control it may not press under fill-and-review, refused it, and ended with `filled: 0` — so there
 * is no filled form, and the thing being authorised is the submission itself. The sentence now
 * describes what the approval DOES rather than a form that may not exist.
 */
const APPROVE_CONTINUE_CONFIRM =
	"Approve THIS application and let it be submitted? The approval covers this one job only and is used once. If its run has already finished — because the form is waiting for you, or because it stopped at a control it may not press on its own — the approval is held and one fresh run sends it. Nothing is submitted twice.";

export const confirmText = (action: ApplicationQueueAction, status?: string): string | undefined =>
	action === "approve_and_proceed" && status && status !== "materials_ready" ? APPROVE_CONTINUE_CONFIRM : CONFIRM[action];

/** The request for one action on one item — always with the status and version it was read in. */
export function actionBody(item: ApplicationQueueItem, action: ApplicationQueueAction, extra: { answers?: Array<{ question: string; answer: string }> } = {}): Record<string, unknown> {
	const target = item.applicationId
		? { application_id: item.applicationId, expected_version: item.stateVersion ?? undefined }
		: { scout_instance_id: item.scoutInstanceId, record_id: item.leadId, expected_version: item.leadVersion ?? undefined };
	// #973: an approval carries the key the server would derive anyway, so a double-click or a
	// retried request reuses the same authorization instead of racing for a second one.
	// The key shape follows the STAGE, matching what the server derives for the same decision, so a
	// retry from either surface reuses one authorization instead of racing for a second.
	const idem =
		action === "approve_and_proceed" && item.applicationId
			? { idempotency_key: `${item.status === "materials_ready" ? "approve" : "approve-continue"}:${item.applicationId}:${item.stateVersion ?? 0}` }
			: {};
	return { action, expected_status: item.status, ...target, ...idem, ...(extra.answers?.length ? { answers: extra.answers } : {}) };
}
