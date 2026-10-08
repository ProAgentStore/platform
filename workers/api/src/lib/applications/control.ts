/**
 * The Applications control surface (#958) — ONE service behind the console's Applications tab and
 * the typed MCP application tools (`workers/mcp/src/instance-tools/applications.ts`), which call
 * the same routes.
 *
 * An application flows through three of the owner's instances, joined by connections:
 *
 *   Job Search Scout (job_leads)  —job.lead.apply_requested→  Application Tailor (job_applications)
 *                                 —job.application.materials_ready→  Application Runner (local_apply_runs)
 *
 * `pipelineOf` finds that graph from ANY member, so the same queue reads the same from the Tailor's
 * tab or an MCP call made on the Runner. The queue joins a Scout's leads that have no application
 * yet (new, apply_requested, skipped, deferred, archived) with the applications (tailoring through
 * submitted). Every state change goes through `performApplicationAction`, which calls the very
 * functions the lifecycle already has — `runJobLeadTriage` (#955), `startTailoring` /
 * `retryTailoring` (#956), `startApplicationFill` / `retryFill` / `cancelApplyRun` /
 * `resumeApplyRun` (#957) and `moveApplication` — so the console and MCP land identical
 * transitions and identical audit rows. Defer and archive change PAGS records only; nothing here
 * clicks anything on an employer's site.
 *
 * Privacy: items carry the lead's whitelisted fields (no contact details or notes), artifact
 * HANDLES (owner-visible path + sha256), status and actionable pause reasons — never résumé text,
 * profile values, typed form values, cookies or the owner's answers.
 */
import { HttpError } from "../auth.js";
import { capabilitiesForInstance } from "../agent-capabilities.js";
import { JOB_LEAD_APPLY_EVENT, JOB_LEAD_TRANSITIONS, type JobLeadStatus, jobLeadStatus, jobLeadVersion } from "../job-lead-triage.js";
import { MATERIALS_READY_EVENT } from "../local-artifact/contract.js";
import { type JobApplication, getOwnedApplication, getTailorRun } from "../local-artifact/store.js";
import { cancelTailoring, retryTailoring, startTailoring } from "../local-artifact/tailor.js";
import { cancelApplyRun, resumeApplyRun, retryFill, runnerSettingsFor, startApplicationFill, submitGateFor } from "../local-apply/apply.js";
import { approvalEligibility, approvalState } from "../local-apply/approval.js";
import { getSubmitAuthorization, grantSubmitAuthorization } from "../local-apply/approval-store.js";
import { type ApplyRun, applicationAudit, getApplyRun, moveApplication } from "../local-apply/store.js";
import type { Env } from "../../types.js";
import { runJobLeadTriage } from "../../routes/instances-job-leads.js";

export const QUEUE_STATUSES = ["new", "apply_requested", "tailoring", "materials_ready", "filling", "awaiting_review", "submitted", "blocked", "deferred", "skipped", "archived", "failed"] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export const APPLICATION_ACTIONS = ["apply", "skip", "defer", "archive", "generate_materials", "retry_tailoring", "start_fill", "request_review", "retry_fill", "cancel", "resume", "mark_not_interested", "approve_and_proceed"] as const;
export type ApplicationAction = (typeof APPLICATION_ACTIONS)[number];

export interface Pipeline {
	scouts: string[];
	tailors: string[];
	runners: string[];
}

export interface QueueItem {
	/** `lead:<scout>:<recordId>` or `app:<applicationId>` — stable across reads. */
	key: string;
	kind: "lead" | "application";
	status: QueueStatus;
	title: string;
	company: string | null;
	location: string | null;
	url: string | null;
	source: string | null;
	postedDate: string | null;
	matchRationale: string | null;
	scoutInstanceId: string | null;
	leadId: string;
	/** The lead's lifecycle_version — compare-and-set for a lead action. */
	leadVersion: number | null;
	applicationId: string | null;
	tailorInstanceId: string | null;
	/** The application's state_version — compare-and-set for an application action. */
	stateVersion: number | null;
	blockReason: string | null;
	/** What the owner must answer or do — actionable, never a source excerpt chosen by us. */
	questions: string[];
	artifacts: { resume: unknown; coverLetter: unknown } | null;
	profileVersion: string | null;
	tailoringRunId: string | null;
	fillRunId: string | null;
	/** The open fill run's status and pause, when there is one. */
	fillRun: { id: string; status: string; mode: string | null; pause: unknown } | null;
	submittedAt: string | null;
	submittedUrl: string | null;
	submitAttempted: boolean;
	/**
	 * Would a fill submit on its own? Only on a `materials_ready` application: the Runner's gate,
	 * previewed. `start_fill` appears in `actions` ONLY when this says allowed — the final-submit
	 * control is never offered under the default fill-and-review policy.
	 */
	submitPolicy: { allowed: boolean; failing: string[] } | null;
	/**
	 * The owner's per-application submission approval (#973), when one has ever been granted:
	 * whether it is still usable, the words to show, who granted it and when, and the run that
	 * spent it. Null when this application was never approved — which is the default, and the
	 * reason an unapproved application cannot submit.
	 */
	submitAuthorization: { id: string; usable: boolean; label: string; approvedBy: string; approvedAt: string; approvedStateVersion: number; idempotencyKey: string; consumedAt: string | null; consumedRunId: string | null } | null;
	updatedAt: string;
	actions: ApplicationAction[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const iso = (ms: number) => new Date(ms).toISOString();

/** The Scout → Tailor → Runner graph around one instance, from the owner's own connections. */
export async function pipelineOf(env: Env, uid: string, instanceId: string): Promise<Pipeline> {
	const { results } = await env.DB.prepare(
		"SELECT source_instance_id AS s, target_instance_id AS t FROM agent_connections WHERE user_id = ?1 AND enabled = 1 AND event_type IN (?2, ?3)",
	)
		.bind(uid, JOB_LEAD_APPLY_EVENT, MATERIALS_READY_EVENT)
		.all<{ s: string; t: string }>();
	const edges = results ?? [];
	const seen = new Set([instanceId]);
	const queue = [instanceId];
	while (queue.length) {
		const at = queue.shift() as string;
		for (const e of edges) {
			for (const [a, b] of [[e.s, e.t], [e.t, e.s]] as const) {
				if (a === at && !seen.has(b)) {
					seen.add(b);
					queue.push(b);
				}
			}
		}
	}
	const out: Pipeline = { scouts: [], tailors: [], runners: [] };
	for (const id of seen) {
		const runtime = (await capabilitiesForInstance(env, id, uid))?.runtime;
		if (runtime === "local_browser") out.scouts.push(id);
		else if (runtime === "local_artifact") out.tailors.push(id);
		else if (runtime === "local_apply") out.runners.push(id);
	}
	if (!out.tailors.length && !out.runners.length && !out.scouts.length) {
		throw new HttpError(409, "This agent is not part of an application pipeline (a Job Search Scout, an Application Tailor or an Application Runner, joined by connections).");
	}
	return out;
}

interface LeadRecord {
	id: string;
	data: Record<string, unknown>;
	updatedAt?: string;
}

/** A Scout's leads, newest first. A Scout without the collection yet simply has none. */
async function scoutLeads(env: Env, scout: string): Promise<{ records: LeadRecord[]; total: number }> {
	const res = await env.AGENT.get(env.AGENT.idFromName(scout)).fetch(new Request("https://agent/collections/job_leads/records?limit=200&order_by=updated_at&order_dir=desc"));
	if (!res.ok) return { records: [], total: 0 };
	const body = (await res.json()) as { records?: LeadRecord[]; total?: number };
	return { records: body.records ?? [], total: body.total ?? 0 };
}

async function readLead(env: Env, scout: string, recordId: string): Promise<LeadRecord | null> {
	const res = await env.AGENT.get(env.AGENT.idFromName(scout)).fetch(new Request(`https://agent/collections/job_leads/records/${encodeURIComponent(recordId)}`));
	return res.ok ? ((await res.json()) as LeadRecord) : null;
}

const LEAD_ACTION: Partial<Record<JobLeadStatus, ApplicationAction>> = { apply_requested: "apply", skipped: "skip", deferred: "defer", archived: "archive" };

function leadItem(scout: string, r: LeadRecord, pipeline: Pipeline): QueueItem {
	const d = r.data;
	const status = jobLeadStatus(d);
	const actions: ApplicationAction[] = JOB_LEAD_TRANSITIONS[status].map((t) => LEAD_ACTION[t]).filter((a): a is ApplicationAction => !!a);
	if (status === "apply_requested" && pipeline.tailors.length) actions.push("generate_materials");
	// #953: "not interested" is a skip where the lead can still be skipped, else an archive.
	if (actions.includes("skip") || actions.includes("archive")) actions.push("mark_not_interested");
	return {
		key: `lead:${scout}:${r.id}`,
		kind: "lead",
		status: (QUEUE_STATUSES as readonly string[]).includes(status) ? (status as QueueStatus) : "new",
		title: str(d.title) ?? "(untitled lead)",
		company: str(d.company),
		location: str(d.location),
		url: str(d.url),
		source: str(d.source),
		postedDate: str(d.posted_date),
		matchRationale: str(d.match_rationale),
		scoutInstanceId: scout,
		leadId: r.id,
		leadVersion: jobLeadVersion(d),
		applicationId: null,
		tailorInstanceId: null,
		stateVersion: null,
		blockReason: null,
		questions: [],
		artifacts: null,
		profileVersion: null,
		tailoringRunId: null,
		fillRunId: null,
		fillRun: null,
		submittedAt: null,
		submittedUrl: null,
		submitAttempted: false,
		submitPolicy: null,
		submitAuthorization: null,
		updatedAt: str(r.updatedAt) ?? "",
		actions,
	};
}

interface OpenRun {
	id: string;
	status: string;
	mode: string | null;
	pause: unknown;
}

/** The actions an application in this state can take — the lifecycle table, read for the owner. */
function applicationActions(app: JobApplication, pipeline: Pipeline, run: OpenRun | null, submitAllowed: boolean, auth: QueueItem["submitAuthorization"] = null): ApplicationAction[] {
	const canFill = pipeline.runners.length > 0;
	switch (app.status) {
		case "tailoring":
			return ["cancel"];
		case "materials_ready":
			// `approve_and_proceed` (#973) is the owner's per-application decision, offered while the
			// card is still waiting for one. `start_fill` remains the standing-policy path: it appears
			// when the gate already allows a submit — which an approval is one way to achieve, so an
			// approved card shows `start_fill` rather than a second Approve button.
			return [
				...(canFill && !auth && !app.submitAttemptedAt ? (["approve_and_proceed"] as const) : []),
				...(canFill && submitAllowed ? (["start_fill"] as const) : []),
				...(canFill ? (["request_review"] as const) : []),
				"defer",
				"archive",
			];
		case "filling":
			return ["cancel"];
		case "blocked":
			if (run) return run.status === "paused" ? ["resume", "cancel"] : ["cancel"];
			if (app.fillRunId) return [...(canFill && !app.submitAttemptedAt ? (["retry_fill"] as const) : []), "defer", "archive"];
			return ["retry_tailoring", "defer", "archive"];
		case "failed":
		case "cancelled":
			if (app.fillRunId) return [...(canFill && !app.submitAttemptedAt && app.status === "failed" ? (["retry_fill"] as const) : []), "archive"];
			return ["retry_tailoring", "archive"];
		case "awaiting_review":
			return ["defer", "archive"];
		case "deferred":
			return ["apply", "archive"];
		default:
			return [];
	}
}

/** #953: an application that can be archived can be marked not interested (an archive, with that reason). */
const withNotInterested = (actions: ApplicationAction[]): ApplicationAction[] => (actions.includes("archive") ? [...actions, "mark_not_interested"] : actions);

function applicationItem(app: JobApplication, pipeline: Pipeline, run: OpenRun | null, policy: QueueItem["submitPolicy"], auth: QueueItem["submitAuthorization"] = null): QueueItem {
	const env = (app.lead ?? {}) as { leadUrl?: string; lead?: Record<string, unknown> };
	const l = env.lead ?? {};
	return {
		key: `app:${app.id}`,
		kind: "application",
		status: app.status === "cancelled" ? "failed" : (app.status as QueueStatus),
		title: str(l.title) ?? "(untitled)",
		company: str(l.company),
		location: str(l.location),
		url: str(env.leadUrl) ?? str(l.url),
		source: str(l.source),
		postedDate: str(l.posted_date),
		matchRationale: str(l.match_rationale),
		scoutInstanceId: app.sourceInstanceId,
		leadId: app.leadId,
		leadVersion: app.lifecycleVersion,
		applicationId: app.id,
		tailorInstanceId: app.instanceId,
		stateVersion: app.stateVersion,
		blockReason: app.status === "cancelled" ? "cancelled" : app.blockReason,
		questions: app.blockQuestions,
		artifacts: app.resumeArtifact || app.coverLetterArtifact ? { resume: app.resumeArtifact, coverLetter: app.coverLetterArtifact } : null,
		profileVersion: app.profileVersion,
		tailoringRunId: app.tailoringRunId,
		fillRunId: app.fillRunId,
		fillRun: run,
		submittedAt: app.submittedAt,
		submittedUrl: app.submittedUrl,
		submitAttempted: !!app.submitAttemptedAt,
		submitPolicy: policy,
		submitAuthorization: auth,
		updatedAt: iso(app.updatedAt),
		actions: withNotInterested(applicationActions(app, pipeline, run, !!policy?.allowed, auth)),
	};
}

async function applicationsOf(env: Env, uid: string, tailors: string[]): Promise<JobApplication[]> {
	const out: JobApplication[] = [];
	for (const t of tailors) {
		const { results } = await env.DB.prepare("SELECT id FROM job_applications WHERE instance_id = ?1 AND user_id = ?2 ORDER BY updated_at DESC LIMIT 500").bind(t, uid).all<{ id: string }>();
		for (const r of results ?? []) {
			const app = await getOwnedApplication(env, uid, r.id);
			if (app) out.push(app);
		}
	}
	return out;
}

async function openRuns(env: Env, uid: string, runners: string[]): Promise<Map<string, OpenRun>> {
	const map = new Map<string, OpenRun>();
	for (const r of runners) {
		const { results } = await env.DB.prepare("SELECT id, status, pause, json_extract(policy, '$.mode') AS mode FROM local_apply_runs WHERE instance_id = ?1 AND user_id = ?2 AND status IN ('queued', 'running', 'paused')")
			.bind(r, uid)
			.all<{ id: string; status: string; pause: string | null; mode: string | null }>();
		for (const row of results ?? []) map.set(row.id, { id: row.id, status: row.status, mode: row.mode, pause: row.pause ? JSON.parse(row.pause) : null });
	}
	return map;
}

/** The gate preview per Runner, for each materials_ready application. Fails closed. */
/** The card's view of the owner's approval (#973), for every application that has ever had one. */
async function approvalViews(env: Env, uid: string, apps: JobApplication[]): Promise<Map<string, QueueItem["submitAuthorization"]>> {
	const out = new Map<string, QueueItem["submitAuthorization"]>();
	for (const app of apps) {
		const auth = await getSubmitAuthorization(env, app.id, uid).catch(() => null);
		if (!auth) continue;
		const state = approvalState(auth, app);
		out.set(app.id, {
			id: auth.id,
			usable: state.usable,
			label: state.label,
			approvedBy: auth.approvedBy,
			approvedAt: iso(auth.approvedAt),
			approvedStateVersion: auth.approvedStateVersion,
			// Returned so the key a caller sent is readable back — a retry can confirm which
			// decision the stored authorization belongs to (#574's write/read reachability).
			idempotencyKey: auth.idempotencyKey,
			consumedAt: auth.consumedAt ? iso(auth.consumedAt) : null,
			consumedRunId: auth.consumedRunId,
		});
	}
	return out;
}

async function policyPreviews(env: Env, uid: string, pipeline: Pipeline, apps: JobApplication[]): Promise<Map<string, QueueItem["submitPolicy"]>> {
	const out = new Map<string, QueueItem["submitPolicy"]>();
	const runner = pipeline.runners[0];
	const ready = apps.filter((a) => a.status === "materials_ready");
	if (!runner || !ready.length) return out;
	const settings = await runnerSettingsFor(env, runner, uid).catch(() => null);
	for (const app of ready) {
		if (!settings) {
			out.set(app.id, { allowed: false, failing: ["settings_invalid"] });
			continue;
		}
		const g = await submitGateFor(env, runner, uid, app, settings, Date.now());
		out.set(app.id, { allowed: g.allowed, failing: g.checks.filter((c) => !c.ok).map((c) => c.check) });
	}
	return out;
}

export interface QueueView {
	pipeline: Pipeline;
	items: QueueItem[];
	counts: Record<QueueStatus, number>;
	/** Per Runner: is auto-submit on, and how much of today's cap is left. */
	limits: Array<{ runnerInstanceId: string; autoSubmitEnabled: boolean; dailyCap: number; usedToday: number; remaining: number }>;
	/** The connections that carry the flow, with their outbox health — dead letters can be replayed. */
	connections: Array<{ id: string; eventType: string; sourceInstanceId: string; targetInstanceId: string; action: string; enabled: boolean; pending: number; delivered: number; dead: number }>;
	notes: string[];
}

/** Narrowing the queue (#953): every text filter is a case-insensitive "contains"; dates bound `updatedAt`. */
export interface QueueFilter {
	status?: QueueStatus;
	company?: string;
	/** Matched against the job title. */
	role?: string;
	source?: string;
	url?: string;
	/** ISO date or time: items updated at or after it. */
	since?: string;
	/** ISO date or time: items updated before it. */
	until?: string;
	sort?: "updated" | "title";
}

export function matchesFilter(i: QueueItem, f: QueueFilter): boolean {
	const has = (v: string | null, q?: string) => !q || (!!v && v.toLowerCase().includes(q.trim().toLowerCase()));
	if (f.status && i.status !== f.status) return false;
	if (!has(i.company, f.company) || !has(i.title, f.role) || !has(i.source, f.source) || !has(i.url, f.url)) return false;
	if ((f.since || f.until) && !i.updatedAt) return false;
	if (f.since && i.updatedAt < new Date(f.since).toISOString()) return false;
	if (f.until && i.updatedAt >= new Date(f.until).toISOString()) return false;
	return true;
}

export async function applicationQueue(env: Env, uid: string, instanceId: string, opts: QueueFilter = {}): Promise<QueueView> {
	const pipeline = await pipelineOf(env, uid, instanceId);
	const apps = await applicationsOf(env, uid, pipeline.tailors);
	const runs = await openRuns(env, uid, pipeline.runners);
	const previews = await policyPreviews(env, uid, pipeline, apps);
	const approvals = await approvalViews(env, uid, apps);
	const items: QueueItem[] = apps.map((a) => applicationItem(a, pipeline, a.fillRunId ? (runs.get(a.fillRunId) ?? null) : null, previews.get(a.id) ?? null, approvals.get(a.id) ?? null));
	const appLeads = new Set(apps.map((a) => `${a.sourceInstanceId}:${a.leadId}`));
	const notes: string[] = [];
	for (const scout of pipeline.scouts) {
		const { records, total } = await scoutLeads(env, scout);
		if (total > records.length) notes.push(`Scout ${scout}: showing the newest ${records.length} of ${total} leads.`);
		for (const r of records) if (!appLeads.has(`${scout}:${r.id}`)) items.push(leadItem(scout, r, pipeline));
	}
	const counts = Object.fromEntries(QUEUE_STATUSES.map((s) => [s, 0])) as Record<QueueStatus, number>;
	for (const i of items) counts[i.status]++;
	for (const d of [opts.since, opts.until]) if (d && Number.isNaN(Date.parse(d))) throw new HttpError(400, `"${d}" is not a date — pass an ISO date such as 2026-10-01.`);
	const filtered = items.filter((i) => matchesFilter(i, opts));
	filtered.sort(opts.sort === "title" ? (a, b) => a.title.localeCompare(b.title) : (a, b) => b.updatedAt.localeCompare(a.updatedAt));

	const limits: QueueView["limits"] = [];
	for (const r of pipeline.runners) {
		const s = await runnerSettingsFor(env, r, uid).catch(() => null);
		if (!s) continue;
		const used = (await env.DB.prepare("SELECT COUNT(*) AS n FROM local_apply_runs WHERE instance_id = ?1 AND user_id = ?2 AND json_extract(policy, '$.mode') = 'auto_submit' AND created_at >= ?3")
			.bind(r, uid, Date.now() - 86_400_000)
			.first<{ n: number }>())?.n ?? 0;
		limits.push({ runnerInstanceId: r, autoSubmitEnabled: s.autoSubmit.enabled, dailyCap: s.autoSubmit.dailyCap, usedToday: used, remaining: Math.max(0, s.autoSubmit.dailyCap - used) });
	}
	const members = [...pipeline.scouts, ...pipeline.tailors, ...pipeline.runners];
	const { results: conns } = await env.DB.prepare(
		`SELECT c.id, c.event_type, c.source_instance_id, c.target_instance_id, c.action, c.enabled,
		        SUM(CASE WHEN d.status = 'pending' THEN 1 ELSE 0 END) AS pending,
		        SUM(CASE WHEN d.status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
		        SUM(CASE WHEN d.status = 'dead' THEN 1 ELSE 0 END) AS dead
		   FROM agent_connections c LEFT JOIN agent_connection_deliveries d ON d.connection_id = c.id
		  WHERE c.user_id = ?1 AND c.event_type IN (?2, ?3)
		  GROUP BY c.id`,
	)
		.bind(uid, JOB_LEAD_APPLY_EVENT, MATERIALS_READY_EVENT)
		.all<{ id: string; event_type: string; source_instance_id: string; target_instance_id: string; action: string; enabled: number; pending: number | null; delivered: number | null; dead: number | null }>();
	const connections = (conns ?? [])
		.filter((c) => members.includes(c.source_instance_id) || members.includes(c.target_instance_id))
		.map((c) => ({ id: c.id, eventType: c.event_type, sourceInstanceId: c.source_instance_id, targetInstanceId: c.target_instance_id, action: c.action, enabled: c.enabled === 1, pending: Number(c.pending ?? 0), delivered: Number(c.delivered ?? 0), dead: Number(c.dead ?? 0) }));
	return { pipeline, items: filtered, counts, limits, connections, notes };
}

/** One item, current: an application by id, or a lead by Scout + record. */
export async function getQueueItem(env: Env, uid: string, instanceId: string, ref: { applicationId?: string; scoutInstanceId?: string; recordId?: string }): Promise<{ item: QueueItem; pipeline: Pipeline }> {
	const pipeline = await pipelineOf(env, uid, instanceId);
	if (ref.applicationId) {
		const app = await getOwnedApplication(env, uid, ref.applicationId);
		if (!app || !pipeline.tailors.includes(app.instanceId)) throw new HttpError(404, "No such application in this pipeline.");
		const runs = await openRuns(env, uid, pipeline.runners);
		const previews = await policyPreviews(env, uid, pipeline, [app]);
		const approvals = await approvalViews(env, uid, [app]);
		return { item: applicationItem(app, pipeline, app.fillRunId ? (runs.get(app.fillRunId) ?? null) : null, previews.get(app.id) ?? null, approvals.get(app.id) ?? null), pipeline };
	}
	if (ref.scoutInstanceId && ref.recordId) {
		if (!pipeline.scouts.includes(ref.scoutInstanceId)) throw new HttpError(404, "No such Scout in this pipeline.");
		const lead = await readLead(env, ref.scoutInstanceId, ref.recordId);
		if (!lead) throw new HttpError(404, "No such lead.");
		const { results } = await env.DB.prepare("SELECT id FROM job_applications WHERE user_id = ?1 AND source_instance_id = ?2 AND lead_id = ?3 ORDER BY created_at DESC LIMIT 1")
			.bind(uid, ref.scoutInstanceId, ref.recordId)
			.all<{ id: string }>();
		if (results?.[0]) return getQueueItem(env, uid, instanceId, { applicationId: results[0].id });
		return { item: leadItem(ref.scoutInstanceId, lead, pipeline), pipeline };
	}
	throw new HttpError(400, "Name an application_id, or a scout_instance_id with a record_id.");
}

export interface ActionInput {
	action: ApplicationAction;
	applicationId?: string;
	scoutInstanceId?: string;
	recordId?: string;
	/** Compare-and-set: the status you saw. Required — an action on a state nobody looked at is refused. */
	expectedStatus?: string;
	/** Compare-and-set: the version you saw (`stateVersion`, or `leadVersion` for a lead). */
	expectedVersion?: number;
	runnerInstanceId?: string;
	note?: string;
	deferUntil?: string;
	answers?: Array<{ question: string; answer: string }>;
	/**
	 * The caller's own key for an `approve_and_proceed` (#973), so a retry it cannot tell succeeded
	 * reuses the same authorization. Omitted, the key is derived from the application and the state
	 * version the owner approved, which makes the same decision idempotent either way.
	 */
	idempotencyKey?: string;
}

export function parseActionInput(raw: unknown): ActionInput {
	const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
	const action = o.action as ApplicationAction;
	if (!APPLICATION_ACTIONS.includes(action)) throw new HttpError(400, `action must be one of ${APPLICATION_ACTIONS.join(", ")}`);
	const s = (k: string) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : undefined);
	const v = o.expected_version ?? o.expectedVersion;
	if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < 0)) throw new HttpError(400, "expected_version must be a whole number");
	return {
		action,
		applicationId: s("application_id") ?? s("applicationId"),
		scoutInstanceId: s("scout_instance_id") ?? s("scoutInstanceId"),
		recordId: s("record_id") ?? s("recordId"),
		expectedStatus: s("expected_status") ?? s("expectedStatus"),
		expectedVersion: v as number | undefined,
		runnerInstanceId: s("runner_instance_id") ?? s("runnerInstanceId"),
		note: s("note"),
		deferUntil: s("defer_until") ?? s("deferUntil"),
		answers: Array.isArray(o.answers) ? (o.answers as ActionInput["answers"]) : undefined,
		idempotencyKey: s("idempotency_key") ?? s("idempotencyKey"),
	};
}

const LEAD_ACTIONS: readonly ApplicationAction[] = ["apply", "skip", "defer", "archive"];

/**
 * Perform one action — the single entry point for the console and every typed MCP tool. Compare-and-set
 * on the status (and version, when given) the caller saw; a stale or invalid move is refused (409)
 * with nothing written. Returns the item as it now stands.
 */
export async function performApplicationAction(env: Env, uid: string, instanceId: string, input: ActionInput): Promise<{ item: QueueItem; result: Record<string, unknown> }> {
	if (!input.expectedStatus) throw new HttpError(400, "expected_status is required: pass the status you saw, so a stale decision is refused rather than applied.");
	const pipeline = await pipelineOf(env, uid, instanceId);
	const stale = (now: string, version?: number) =>
		new HttpError(409, `stale: this is now ${now}${version !== undefined ? ` (version ${version})` : ""}, not ${input.expectedStatus}${input.expectedVersion !== undefined ? ` (version ${input.expectedVersion})` : ""} — reload it and decide again.`);

	// ── A lead with no application yet ──────────────────────────────────────────────────────
	if (!input.applicationId) {
		const { item } = await getQueueItem(env, uid, instanceId, { scoutInstanceId: input.scoutInstanceId, recordId: input.recordId });
		if (item.kind === "application") {
			return performApplicationAction(env, uid, instanceId, { ...input, applicationId: item.applicationId as string });
		}
		const scout = item.scoutInstanceId as string;
		if (item.status !== input.expectedStatus || (input.expectedVersion !== undefined && input.expectedVersion !== item.leadVersion)) throw stale(item.status, item.leadVersion ?? undefined);
		if (!item.actions.includes(input.action)) throw new HttpError(409, `A lead in ${item.status} cannot ${input.action.replace(/_/g, " ")}${item.actions.length ? ` (it can: ${item.actions.join(", ")})` : ""}.`);
		if (LEAD_ACTIONS.includes(input.action) || input.action === "mark_not_interested") {
			const notInterested = input.action === "mark_not_interested";
			const out = await runJobLeadTriage(env, scout, uid, item.leadId, {
				action: notInterested ? (item.actions.includes("skip") ? "skip" : "archive") : input.action,
				expected_status: item.status,
				expected_version: item.leadVersion,
				...(input.note || notInterested ? { note: input.note ?? "not interested" } : {}),
				...(input.deferUntil ? { defer_until: input.deferUntil } : {}),
			});
			if (out.status !== 200) throw new HttpError(out.status as 400, out.result.error ?? `triage failed (${out.status})`);
			return { item: (await getQueueItem(env, uid, instanceId, { scoutInstanceId: scout, recordId: item.leadId })).item, result: { transitioned: out.result.transitioned ?? false, delivery: out.result.delivery ?? null } };
		}
		// generate_materials: hand the lead's stored, stable handoff to the Tailor — the very event its Apply produced.
		const lead = await readLead(env, scout, item.leadId);
		const handoff = lead?.data.apply_handoff;
		if (!handoff) throw new HttpError(409, "This lead has no stored apply handoff; Apply it again from the Scout.");
		const out = await startTailoring(env, pipeline.tailors[0], uid, handoff, "owner");
		return { item: (await getQueueItem(env, uid, instanceId, { applicationId: out.application.id })).item, result: { outcome: out.kind, runId: out.run?.id ?? null } };
	}

	// ── An application ───────────────────────────────────────────────────────────────────────
	const { item } = await getQueueItem(env, uid, instanceId, { applicationId: input.applicationId });
	const app = (await getOwnedApplication(env, uid, input.applicationId)) as JobApplication;
	if ((input.expectedStatus !== app.status && input.expectedStatus !== item.status) || (input.expectedVersion !== undefined && input.expectedVersion !== app.stateVersion)) throw stale(app.status, app.stateVersion);
	if (!item.actions.includes(input.action)) {
		const why = input.action === "start_fill" && app.status === "materials_ready" ? " — this application's policy does not allow an automatic submit; use request_review" : "";
		throw new HttpError(409, `An application in ${app.status} cannot ${input.action.replace(/_/g, " ")}${why}${item.actions.length ? ` (it can: ${item.actions.join(", ")})` : ""}.`);
	}
	const runner = input.runnerInstanceId ?? pipeline.runners[0];
	if (input.runnerInstanceId && !pipeline.runners.includes(input.runnerInstanceId)) throw new HttpError(404, "No such Application Runner in this pipeline.");
	const now = Date.now();
	const after = async (result: Record<string, unknown>) => ({ item: (await getQueueItem(env, uid, instanceId, { applicationId: app.id })).item, result });

	switch (input.action) {
		case "defer":
		case "archive":
		case "mark_not_interested":
		case "apply": {
			// PAGS records only — nothing external. `apply` on a deferred application puts it back in the
			// queue; "not interested" is an archive that says why (#953).
			const to = input.action === "defer" ? "deferred" : input.action === "apply" ? "materials_ready" : "archived";
			const reason = input.note ?? (input.action === "mark_not_interested" ? "not_interested" : input.action);
			const moved = await moveApplication(env, app, uid, { to, actor: "owner", actorInstanceId: instanceId, reason }, now);
			if (!moved) throw stale("changed", undefined);
			return after({ transitioned: true });
		}
		case "retry_tailoring": {
			const out = await retryTailoring(env, app.instanceId, uid, app, now);
			return after({ runId: out.run.id });
		}
		case "approve_and_proceed": {
			// ONE owner action: record the authorization, then dispatch the fill that spends it. The
			// grant is idempotent (unique on the application), and `startApplicationFill` is already
			// replay-safe on the event id — so a double-click, a retried MCP call and a redelivered
			// event all converge on one authorization and one run, never a second submission.
			if (!app.readyEvent) throw new HttpError(409, "The application has no materials_ready event to fill from.");
			const existingAuth = await getSubmitAuthorization(env, app.id, uid);
			const eligible = approvalEligibility(app, existingAuth);
			if (!eligible.eligible) throw new HttpError(409, `This application cannot be approved: ${eligible.why}.`);
			const granted = await grantSubmitAuthorization(
				env,
				{
					app,
					instanceId: app.instanceId,
					userId: uid,
					approvedBy: "owner",
					// The caller's key when it sent one, else one derived from exactly what was approved:
					// the application and the state the owner saw. A retry of the same decision reuses it.
					idempotencyKey: input.idempotencyKey ?? `approve:${app.id}:${app.stateVersion}`,
				},
				now,
			);
			const out = await startApplicationFill(env, runner, uid, app.readyEvent, "owner");
			const after = await getSubmitAuthorization(env, app.id, uid);
			return {
				item: (await getQueueItem(env, uid, instanceId, { applicationId: app.id })).item,
				result: {
					outcome: out.kind,
					approval: granted.kind,
					authorizationId: granted.authorization.id,
					// What actually happened to the authorization: `consumed` is the run that may submit.
					authorizationConsumedBy: after?.consumedRunId ?? null,
					runId: out.run?.id ?? null,
					mode: out.run?.policy.mode ?? null,
					nextAction: out.run?.policy.mode === "auto_submit" ? "the Runner fills this application and submits it" : "the Runner fills this application and stops for review",
				},
			};
		}
		case "start_fill":
		case "request_review": {
			if (!app.readyEvent) throw new HttpError(409, "The application has no materials_ready event to fill from.");
			const out = await startApplicationFill(env, runner, uid, app.readyEvent, "owner", { review: input.action === "request_review" });
			return after({ outcome: out.kind, runId: out.run?.id ?? null, mode: out.run?.policy.mode ?? null });
		}
		case "retry_fill": {
			const out = await retryFill(env, runner, uid, app);
			return after({ outcome: out.kind, runId: out.run?.id ?? null, mode: out.run?.policy.mode ?? null });
		}
		case "cancel": {
			if (app.status === "tailoring") {
				const run = app.tailoringRunId ? await getTailorRun(env, app.instanceId, uid, app.tailoringRunId) : null;
				if (!run) throw new HttpError(409, "No tailoring run to cancel.");
				await cancelTailoring(env, uid, run, now);
				return after({ cancelled: run.id });
			}
			const run = await fillRun(env, uid, pipeline, app);
			await cancelApplyRun(env, uid, run, now);
			return after({ cancelled: run.id });
		}
		case "resume": {
			const run = await fillRun(env, uid, pipeline, app);
			const resumed = await resumeApplyRun(env, uid, run, { answers: input.answers ?? [] });
			return after({ runStatus: resumed.status });
		}
		default:
			throw new HttpError(409, `${input.action} does not apply to an application.`);
	}
}

async function fillRun(env: Env, uid: string, pipeline: Pipeline, app: JobApplication): Promise<ApplyRun> {
	for (const r of pipeline.runners) {
		const run = app.fillRunId ? await getApplyRun(env, r, uid, app.fillRunId) : null;
		if (run) return run;
	}
	throw new HttpError(409, "No fill run for this application.");
}

export interface TraceEntry {
	at: string;
	/** lead (the Scout's triage) · delivery (the outbox) · tailor · runner (a run's trace) · lifecycle (the audit). */
	source: "lead" | "delivery" | "tailor" | "runner" | "lifecycle";
	type: string;
	instanceId: string | null;
	runId: string | null;
	detail: Record<string, unknown>;
}

/**
 * Scout lead → triage → Tailor run → Runner run(s) → final record, on one timeline (#958). Every
 * entry is already whitelisted where it was written (run traces keep classes, decisions and
 * handles; the audit keeps statuses and reasons); delivery payloads are NOT included, only their
 * correlation and status.
 */
export async function applicationTrace(env: Env, uid: string, instanceId: string, applicationId: string): Promise<{ applicationId: string; correlation: Record<string, unknown>; entries: TraceEntry[] }> {
	const { item } = await getQueueItem(env, uid, instanceId, { applicationId });
	const app = (await getOwnedApplication(env, uid, applicationId)) as JobApplication;
	const entries: TraceEntry[] = [];
	const lead = await readLead(env, app.sourceInstanceId, app.leadId).catch(() => null);
	for (const e of Array.isArray(lead?.data.lifecycle) ? (lead?.data.lifecycle as Array<Record<string, unknown>>) : []) {
		entries.push({ at: String(e.at ?? ""), source: "lead", type: `triage.${String(e.action ?? "")}`, instanceId: app.sourceInstanceId, runId: null, detail: { from: e.from, to: e.to, version: e.version } });
	}
	const readyId = typeof app.readyEvent?.eventId === "string" ? app.readyEvent.eventId : null;
	const { results: deliveries } = await env.DB.prepare(
		"SELECT id, event_type, source_instance_id, target_instance_id, action, status, attempts, last_error, created_at, updated_at, trace_id FROM agent_connection_deliveries WHERE user_id = ?1 AND (trace_id = ?2 OR trace_id = ?3) ORDER BY created_at",
	)
		.bind(uid, app.idempotencyKey, readyId)
		.all<Record<string, string | number | null>>();
	for (const d of deliveries ?? []) {
		entries.push({ at: String(d.created_at), source: "delivery", type: String(d.event_type), instanceId: String(d.target_instance_id), runId: null, detail: { deliveryId: d.id, action: d.action, status: d.status, attempts: d.attempts, ...(d.last_error ? { lastError: d.last_error } : {}) } });
	}
	const runTrace = async (table: "local_artifact_runs" | "local_apply_runs", source: "tailor" | "runner") => {
		const { results } = await env.DB.prepare(`SELECT id, instance_id, trace FROM ${table} WHERE user_id = ?1 AND application_id = ?2 ORDER BY created_at`).bind(uid, applicationId).all<{ id: string; instance_id: string; trace: string }>();
		for (const r of results ?? []) {
			for (const e of JSON.parse(r.trace || "[]") as Array<{ type: string; at: string; detail?: Record<string, unknown>; pauseReason?: string; domain?: string }>) {
				entries.push({ at: e.at, source, type: e.type, instanceId: r.instance_id, runId: r.id, detail: { ...(e.detail ?? {}), ...(e.pauseReason ? { pauseReason: e.pauseReason } : {}), ...(e.domain ? { domain: e.domain } : {}) } });
			}
		}
		return (results ?? []).map((r) => r.id);
	};
	const tailorRuns = await runTrace("local_artifact_runs", "tailor");
	const fillRuns = await runTrace("local_apply_runs", "runner");
	for (const a of await applicationAudit(env, applicationId, uid)) {
		entries.push({ at: iso(a.at), source: "lifecycle", type: `${a.from}→${a.to}`, instanceId: a.actorInstanceId, runId: a.runId, detail: { version: a.version, actor: a.actor, ...(a.reason ? { reason: a.reason } : {}) } });
	}
	entries.sort((a, b) => a.at.localeCompare(b.at));
	return {
		applicationId,
		correlation: { scoutInstanceId: app.sourceInstanceId, leadId: app.leadId, leadEventId: app.idempotencyKey, tailorInstanceId: app.instanceId, tailoringRunIds: tailorRuns, materialsReadyEventId: readyId, fillRunIds: fillRuns, status: item.status, submittedAt: app.submittedAt, submittedUrl: app.submittedUrl },
		entries,
	};
}
