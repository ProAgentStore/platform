/**
 * The explicit human triage boundary for Job Search Scout leads (#955).
 *
 * Generic collection writes intentionally know nothing about this lifecycle. A lead only enters
 * the application flow through this module, after a human has chosen `apply`; this keeps an
 * agent's ordinary status/note edits — a Data-tab cell edit, an `update_record`, a Scout research
 * result — from accidentally starting a real application.
 *
 *   job_leads.status:
 *     new             → apply_requested | skipped | deferred | archived
 *     deferred        → apply_requested | skipped | archived   (a deferred lead is a new one, later)
 *     skipped         → apply_requested | archived             (the owner changed their mind)
 *     apply_requested → tailoring | blocked | archived
 *
 * `tailoring` and `blocked` are the downstream application flow's states (#956 onwards); they are in
 * the table so this module is the one statement of the lifecycle, but no triage ACTION reaches them.
 *
 * Every transition bumps `lifecycle_version` and appends to `lifecycle` (the audit trail). A caller
 * may pass the status/version it last SAW — compare-and-set — and an action against a lead that
 * has moved since is refused as stale rather than applied to a state nobody looked at.
 */
import type { CollectionRecord } from "../agent-storage-types.js";

export const JOB_LEAD_COLLECTION = "job_leads";
export const JOB_LEAD_APPLY_EVENT = "job.lead.apply_requested";

/** Query keys mailers add for attribution rather than job identity. */
const JOB_URL_TRACKING_KEY = /^(utm_|mc_|ref$|source$|trk$|campaign$|token$)/i;

/**
 * The URL form used for every job-lead identity, whether it arrived from a browser Scout or a
 * Gmail alert. Keeping this here prevents a mailer tracking suffix from creating a second lead
 * that the ordinary duplicate-prevention logic cannot see.
 */
export function canonicalJobUrl(value: string): string | null {
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.hash = "";
		for (const key of [...url.searchParams.keys()]) if (JOB_URL_TRACKING_KEY.test(key)) url.searchParams.delete(key);
		url.searchParams.sort();
		url.pathname = url.pathname.replace(/\/+$/, "") || "/";
		return `${url.protocol}//${url.host.toLowerCase()}${url.pathname}${url.search}`;
	} catch {
		return null;
	}
}

export const JOB_LEAD_TRIAGE_ACTIONS = ["apply", "skip", "defer", "archive"] as const;
export type JobLeadTriageAction = (typeof JOB_LEAD_TRIAGE_ACTIONS)[number];

/**
 * `unverified` means the lead was observed in a source (for example Gmail), but no browser has
 * established that the posting and its apply path are currently live.  It is deliberately not
 * synonymous with `new`: a recent alert is evidence of where we found a lead, never evidence
 * that a vacancy is open.
 */
export const JOB_LEAD_STATUSES = ["unverified", "new", "apply_requested", "skipped", "deferred", "archived", "tailoring", "blocked", "unverifiable"] as const;
export type JobLeadStatus = (typeof JOB_LEAD_STATUSES)[number];

/** The lifecycle, as data — the one place a transition is allowed. */
export const JOB_LEAD_TRANSITIONS: Record<JobLeadStatus, readonly JobLeadStatus[]> = {
	// An email alert is deliberately not eligible for material generation.  A Runner/browser
	// validation writes the durable verification fact first; only then may a human request apply.
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

const TARGET: Record<JobLeadTriageAction, JobLeadStatus> = {
	apply: "apply_requested",
	skip: "skipped",
	defer: "deferred",
	archive: "archived",
};

/** The fields of a lead the application flow may see — no contact details, notes or session data. */
const ENVELOPE_FIELDS = ["title", "company", "location", "url", "source", "posted_date", "match_rationale"] as const;

/** The `job.lead.apply_requested` event (#955) — the issue's envelope, exactly. */
export type JobLeadApplyEvent = {
	eventType: typeof JOB_LEAD_APPLY_EVENT;
	/** `<instance>:<lead>:<lifecycleVersion>` — the same Apply always carries the same identity. */
	eventId: string;
	sourceInstanceId: string;
	leadId: string;
	leadUrl: string;
	/** Stable, instance-scoped job identity. Older handoffs omit it and remain readable. */
	workKey?: string;
	lifecycleVersion: number;
	requestedAt: string;
	lead: Partial<Record<(typeof ENVELOPE_FIELDS)[number], string>>;
};

export type JobLeadTriageInput = {
	action: JobLeadTriageAction;
	deferUntil?: string;
	note?: string;
	/** Compare-and-set: the status the caller saw. A lead that has moved since is refused. */
	expectedStatus?: string;
	/** Compare-and-set: the `lifecycle_version` the caller saw. */
	expectedVersion?: number;
};

/** One entry of a lead's `lifecycle` audit trail. */
export type JobLeadLifecycleEntry = { from: JobLeadStatus; to: JobLeadStatus; action: JobLeadTriageAction; version: number; at: string; note?: string };

export type JobLeadTriagePlan =
	| { ok: true; transitioned: boolean; patch: Record<string, unknown> | null; event: JobLeadApplyEvent | null }
	| { ok: false; error: string; stale?: boolean };

/** The lead's lifecycle state. Rows that predate it (`found`, or no status) are `new`. */
export function jobLeadStatus(data: Record<string, unknown>): JobLeadStatus {
	const status = typeof data.status === "string" ? data.status.trim() : "";
	return (JOB_LEAD_STATUSES as readonly string[]).includes(status) ? (status as JobLeadStatus) : "new";
}

export function jobLeadVersion(data: Record<string, unknown>): number {
	const v = data.lifecycle_version;
	return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

function eventFrom(value: unknown): JobLeadApplyEvent | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as Partial<JobLeadApplyEvent>;
	if (candidate.eventType !== JOB_LEAD_APPLY_EVENT || typeof candidate.eventId !== "string" || !candidate.eventId) return null;
	if (!candidate.lead || typeof candidate.lead !== "object") return null;
	return candidate as JobLeadApplyEvent;
}

/** The whitelisted lead snapshot the event carries. Anything not listed never leaves the lead. */
function envelopeLead(data: Record<string, unknown>): JobLeadApplyEvent["lead"] {
	const out: JobLeadApplyEvent["lead"] = {};
	for (const field of ENVELOPE_FIELDS) if (typeof data[field] === "string" && data[field]) out[field] = data[field] as string;
	return out;
}

/**
 * Plan one human triage decision. The caller performs the returned patch inside the instance DO,
 * making the read/transition/write serial with other edits to that instance. The handoff
 * (`apply_handoff`) is a stable snapshot stored WITH the transition, so retrying the same explicit
 * Apply returns the same event identity even if unrelated lead fields change later.
 */
export function planJobLeadTriage(
	record: CollectionRecord,
	input: JobLeadTriageInput & { sourceInstanceId: string },
	deps: { now?: string } = {},
): JobLeadTriagePlan {
	const current = jobLeadStatus(record.data);
	const version = jobLeadVersion(record.data);
	const target = TARGET[input.action];
	if (input.action === "apply" && current === "unverified") {
		return { ok: false, error: "This email lead is unverified. Validate its live job page and active apply path before requesting materials; email freshness is not proof that the vacancy is open." };
	}
	if (input.action === "apply" && current === "unverifiable") {
		return { ok: false, error: "This lead could not be verified as live. It cannot request materials or submission; defer, skip, or archive it instead." };
	}

	// Already there: a retry of the decision that was made, not a new one. Apply returns its stored
	// handoff so a retry after an outbox failure re-delivers the SAME event, which the outbox dedupes.
	if (current === target) {
		const event = input.action === "apply" ? eventFrom(record.data.apply_handoff) : null;
		if (input.action === "apply" && !event) {
			return { ok: false, error: "This lead is already apply_requested but has no durable apply handoff. Repair the lead before retrying." };
		}
		return { ok: true, transitioned: false, patch: null, event };
	}
	// Compare-and-set (#955): checked after the idempotent repeat above, so two clicks on the same
	// Apply both succeed with one event, while an action taken on a state that has since changed fails.
	if (input.expectedStatus !== undefined && input.expectedStatus !== current && !(input.expectedStatus === "found" && current === "new")) {
		return { ok: false, stale: true, error: `This lead is now ${current}, not ${input.expectedStatus} — reload it and decide again.` };
	}
	if (input.expectedVersion !== undefined && input.expectedVersion !== version) {
		return { ok: false, stale: true, error: `This lead has changed since you read it (lifecycle version ${version}, not ${input.expectedVersion}) — reload it and decide again.` };
	}
	if (!JOB_LEAD_TRANSITIONS[current].includes(target)) {
		return { ok: false, error: `Cannot ${input.action} a lead in ${current} status.` };
	}

	const now = deps.now ?? new Date().toISOString();
	const nextVersion = version + 1;
	const note = input.note?.trim();
	const entry: JobLeadLifecycleEntry = { from: current, to: target, action: input.action, version: nextVersion, at: now, ...(note ? { note } : {}) };
	const history = Array.isArray(record.data.lifecycle) ? record.data.lifecycle : [];
	const patch: Record<string, unknown> = {
		status: target,
		lifecycle_version: nextVersion,
		lifecycle: [...history, entry],
		triage_action: input.action,
		triaged_at: now,
	};
	if (note) patch.triage_note = note;
	if (input.action === "defer" && input.deferUntil?.trim()) patch.defer_until = input.deferUntil.trim();
	if (input.action !== "apply") return { ok: true, transitioned: true, patch, event: null };

	const event: JobLeadApplyEvent = {
		eventType: JOB_LEAD_APPLY_EVENT,
		eventId: `${input.sourceInstanceId}:${record.id}:${nextVersion}`,
		sourceInstanceId: input.sourceInstanceId,
		leadId: record.id,
		leadUrl: typeof record.data.url === "string" ? record.data.url : "",
		...(typeof record.data.work_key === "string" && record.data.work_key ? { workKey: record.data.work_key } : {}),
		lifecycleVersion: nextVersion,
		requestedAt: now,
		lead: envelopeLead(record.data),
	};
	patch.apply_request_id = event.eventId;
	patch.apply_requested_at = now;
	// The handoff record, written in the same update as the transition (#955 step 3).
	patch.apply_handoff = event;
	return { ok: true, transitioned: true, patch, event };
}

// ── #953: one application per job, and the application's status back on the lead ─────────────

/**
 * What makes two leads the SAME job: an explicit job id the Scout recorded (with its source), else
 * the posting URL normalised — scheme and host lowercased, no fragment, no `utm_*` tracking, no
 * trailing slash. Null when the lead carries neither.
 */
export function jobIdentity(data: Record<string, unknown>): string | null {
	const jobId = data.job_id ?? data.jobId;
	if ((typeof jobId === "string" && jobId.trim()) || typeof jobId === "number") {
		const source = typeof data.source === "string" ? data.source.trim().toLowerCase() : "";
		return `id:${source}:${String(jobId).trim()}`;
	}
	if (typeof data.url !== "string" || !data.url.trim()) return null;
	return `url:${canonicalJobUrl(data.url) ?? data.url.trim()}`;
}

/**
 * The durable per-owner work key.  SEEK's numeric posting id is stable across its job and apply
 * URLs; other sources retain the canonical specific posting URL.  It intentionally returns null
 * for malformed/non-specific records rather than inventing an identity from an email title/date.
 */
export function workKeyForLead(data: Record<string, unknown>): string | null {
	const rawUrl = typeof data.url === "string" ? canonicalJobUrl(data.url) : null;
	if (rawUrl) {
		const url = new URL(rawUrl);
		if (/(^|\.)seek\.com\.au$/i.test(url.hostname)) {
			const id = url.pathname.match(/\/(?:job|jobs)\/(\d+)(?:\/|$)/i)?.[1] ?? url.searchParams.get("jobId")?.match(/^\d+$/)?.[0];
			if (id) return `seek:${id}`;
		}
		return `url:${rawUrl}`;
	}
	const jobId = data.job_id ?? data.jobId;
	const source = typeof data.source === "string" ? data.source.trim().toLowerCase().replace(/\s+/g, "_") : "";
	if (((typeof jobId === "string" && jobId.trim()) || typeof jobId === "number") && source) {
		return `${source === "seek" ? "seek" : source}:${String(jobId).trim()}`;
	}
	return null;
}

/**
 * Another lead for the same job that has ALREADY been applied for (it carries an apply handoff) —
 * so applying for this one would be a second application to one posting. Null when there is none.
 */
export function duplicateApplyOf(record: CollectionRecord, others: readonly CollectionRecord[]): string | null {
	const identity = jobIdentity(record.data);
	if (!identity) return null;
	const dup = others.find((o) => o.id !== record.id && typeof o.data.apply_request_id === "string" && jobIdentity(o.data) === identity);
	return dup?.id ?? null;
}

/** The application's state, as the Application Tailor / Runner report it back onto its lead. */
export type JobLeadApplicationWriteback = {
	applicationId: string;
	/** The lead lifecycle_version the application was created from. */
	leadVersion: number;
	status: string;
	/** The application's state_version — writebacks apply in order, a late one is ignored. */
	version: number;
	blockReason?: string | null;
	submittedAt?: string | null;
	submittedUrl?: string | null;
	at: string;
};

/**
 * The patch that records an application's status on its lead, or null when the lead already holds
 * this or a newer one. Newer means: a later application for a later Apply of the lead, or a later
 * state_version of the same application. Writes `application_*` fields only — never `status`, which
 * is the owner's triage lifecycle, and never anything that reaches the outbox.
 */
export function planApplicationWriteback(record: CollectionRecord, w: JobLeadApplicationWriteback): Record<string, unknown> | null {
	const d = record.data;
	const heldLead = typeof d.application_lead_version === "number" ? d.application_lead_version : -1;
	const heldVersion = typeof d.application_version === "number" ? d.application_version : -1;
	const newer = w.leadVersion > heldLead || (w.leadVersion === heldLead && d.application_id === w.applicationId && w.version > heldVersion);
	if (!newer) return null;
	return {
		application_id: w.applicationId,
		application_lead_version: w.leadVersion,
		application_status: w.status,
		application_version: w.version,
		application_block_reason: w.blockReason ?? null,
		application_submitted_at: w.submittedAt ?? null,
		application_submitted_url: w.submittedUrl ?? null,
		application_updated_at: w.at,
	};
}
