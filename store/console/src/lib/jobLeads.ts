/**
 * The job-lead lifecycle as the Data tab renders it (#955) — a mirror of `JOB_LEAD_TRANSITIONS` in
 * `workers/api/src/lib/job-lead-triage.ts` (`jobLeads.test.ts` holds the two equal), so a button is
 * enabled exactly when the server would accept it.
 */
export const JOB_LEAD_ACTIONS = ["apply", "skip", "defer", "archive"] as const;
export type JobLeadAction = (typeof JOB_LEAD_ACTIONS)[number];

export const JOB_LEAD_TRANSITIONS: Record<string, readonly string[]> = {
	// Gmail alerts are intake evidence only. They remain here as a distinct lane until the
	// Runner/browser has verified a live posting and apply path.
	unverified: ["skipped", "deferred", "archived", "unverifiable"],
	new: ["apply_requested", "skipped", "deferred", "archived"],
	deferred: ["apply_requested", "skipped", "archived"],
	skipped: ["apply_requested", "archived"],
	apply_requested: ["tailoring", "blocked", "archived"],
	tailoring: [],
	blocked: [],
	archived: [],
	unverifiable: ["skipped", "deferred", "archived"],
};

/** Board columns, in lifecycle order. */
export const JOB_LEAD_PIPELINE = ["unverified", "new", "deferred", "apply_requested", "tailoring", "blocked", "unverifiable", "skipped", "archived"];

const TARGET: Record<JobLeadAction, string> = { apply: "apply_requested", skip: "skipped", defer: "deferred", archive: "archived" };

/** A lead's lifecycle status; rows from before the lifecycle (`found`, none) are `new`, as on the server. */
export function jobLeadStatus(data: Record<string, unknown>): string {
	const s = typeof data.status === "string" ? data.status.trim() : "";
	return s in JOB_LEAD_TRANSITIONS ? s : "new";
}

/** Would the server accept this action on a lead in this status? */
export function canTriage(status: string, action: JobLeadAction): boolean {
	return (JOB_LEAD_TRANSITIONS[status] ?? []).includes(TARGET[action]);
}
