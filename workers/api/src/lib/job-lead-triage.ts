/**
 * The explicit human triage boundary for Job Search Scout leads (#955).
 *
 * Generic collection writes intentionally know nothing about this lifecycle. A lead only enters
 * the application flow through this module, after a human has chosen `apply`; this keeps an
 * agent's ordinary status/note edits from accidentally starting a real application.
 */
import type { CollectionRecord } from "../agent-storage-types.js";

export const JOB_LEAD_COLLECTION = "job_leads";
export const JOB_LEAD_APPLY_EVENT = "job.lead.apply_requested";

export const JOB_LEAD_TRIAGE_ACTIONS = ["apply", "skip", "defer", "archive"] as const;
export type JobLeadTriageAction = (typeof JOB_LEAD_TRIAGE_ACTIONS)[number];

type LeadStatus = "found" | "deferred" | "apply_requested" | "skipped" | "archived";

export type JobLeadApplyEvent = {
	eventType: typeof JOB_LEAD_APPLY_EVENT;
	eventId: string;
	lead: {
		id: string;
		collection: typeof JOB_LEAD_COLLECTION;
		data: Record<string, unknown>;
	};
};

export type JobLeadTriageInput = {
	action: JobLeadTriageAction;
	deferUntil?: string;
	note?: string;
};

export type JobLeadTriagePlan =
	| { ok: true; transitioned: boolean; patch: Record<string, unknown> | null; event: JobLeadApplyEvent | null }
	| { ok: false; error: string };

function statusOf(data: Record<string, unknown>): LeadStatus {
	const status = typeof data.status === "string" ? data.status.trim() : "";
	// Existing Scout rows predate the lifecycle. Treat their old/missing status as found rather
	// than forcing owners to rewrite their table before they can triage it.
	if (status === "deferred" || status === "apply_requested" || status === "skipped" || status === "archived") return status;
	return "found";
}

function eventFrom(value: unknown): JobLeadApplyEvent | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as Partial<JobLeadApplyEvent>;
	if (candidate.eventType !== JOB_LEAD_APPLY_EVENT || typeof candidate.eventId !== "string" || !candidate.eventId) return null;
	if (!candidate.lead || typeof candidate.lead !== "object") return null;
	return candidate as JobLeadApplyEvent;
}

function canTransition(from: LeadStatus, action: JobLeadTriageAction): boolean {
	if (action === "apply") return from !== "apply_requested" && from !== "archived";
	if (action === "skip") return from === "found" || from === "deferred";
	if (action === "defer") return from === "found";
	return from === "found" || from === "deferred" || from === "skipped";
}

/**
 * Plan one human triage decision. The caller performs the returned patch inside the instance DO,
 * making the read/transition/write serial with other edits to that instance. `apply_handoff` is a
 * stable snapshot so retrying the same explicit Apply produces the same outbox identity even if
 * somebody later changes unrelated lead fields.
 */
export function planJobLeadTriage(
	record: CollectionRecord,
	input: JobLeadTriageInput,
	deps: { now?: string; eventId?: string } = {},
): JobLeadTriagePlan {
	const current = statusOf(record.data);
	const same =
		(input.action === "apply" && current === "apply_requested") ||
		(input.action === "skip" && current === "skipped") ||
		(input.action === "defer" && current === "deferred") ||
		(input.action === "archive" && current === "archived");
	if (same) {
		const event = input.action === "apply" ? eventFrom(record.data.apply_handoff) : null;
		if (input.action === "apply" && !event) {
			return { ok: false, error: "This lead is already apply_requested but has no durable apply handoff. Repair the lead before retrying." };
		}
		return { ok: true, transitioned: false, patch: null, event };
	}
	if (!canTransition(current, input.action)) {
		return { ok: false, error: `Cannot ${input.action} a lead in ${current} status.` };
	}

	const now = deps.now ?? new Date().toISOString();
	const patch: Record<string, unknown> = {
		status:
			input.action === "apply"
				? "apply_requested"
				: input.action === "skip"
					? "skipped"
					: input.action === "defer"
						? "deferred"
						: "archived",
		triage_action: input.action,
		triaged_at: now,
	};
	if (input.note?.trim()) patch.triage_note = input.note.trim();
	if (input.action === "defer" && input.deferUntil?.trim()) patch.defer_until = input.deferUntil.trim();

	if (input.action !== "apply") return { ok: true, transitioned: true, patch, event: null };

	const eventId = deps.eventId ?? crypto.randomUUID();
	patch.apply_request_id = eventId;
	patch.apply_requested_at = now;
	// Snapshot the data that was explicitly approved. Do not include the handoff itself (which
	// would be recursive), and do not derive this later from mutable collection data.
	const approvedData = { ...record.data, ...patch };
	const event: JobLeadApplyEvent = {
		eventType: JOB_LEAD_APPLY_EVENT,
		eventId,
		lead: { id: record.id, collection: JOB_LEAD_COLLECTION, data: approvedData },
	};
	patch.apply_handoff = event;
	return { ok: true, transitioned: true, patch, event };
}
