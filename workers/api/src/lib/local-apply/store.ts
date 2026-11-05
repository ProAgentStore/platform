import { APPEND_APPLY_TRACE_SQL, type ApplyTraceEvent, validTraceAppend } from "./trace-integrity.js";
import type { BrowserWebsiteAccessWire } from "../browser-website-policy.js";
/**
 * Application Runner (#957) — D1 reads/writes: the application lifecycle (compare-and-set + audit)
 * and the durable fill run. Every statement is scoped by `user_id`; runs also by `instance_id`.
 */
import type { Env } from "../../types.js";
import { type ApplicationStatus, type JobApplication, writeBackToLead } from "../local-artifact/store.js";
import { type LocalApplyMode, type LocalApplyPause, traceUrl } from "./contract.js";
import type { LocalApplyHandoffTerminalReason } from "./handoff-contract.js";
import type { GateCheck } from "./policy.js";

type DB = Pick<Env, "DB"> & Partial<Pick<Env, "AGENT">>;

// ── The application lifecycle ────────────────────────────────────────────────────────────────

/**
 * The application lifecycle, as data (#957, #958). `tailoring`'s exits are taken by the Tailor's
 * own settle (`local-artifact/store.ts`); every other move goes through {@link moveApplication}.
 *
 *  - `blocked` may also end in `awaiting_review` / `submitted`: a run's own result can arrive after
 *    a pause PAGS mirrored and before it saw the resume, and a confirmed submit is recorded whatever
 *    PAGS last thought.
 *  - Retry (#958): a stopped TAILORING goes back to `tailoring`; a stopped FILL goes back to
 *    `materials_ready` and is started again. Which one applies is decided by the caller from
 *    `fill_run_id`, and neither is allowed after any submit attempt.
 *  - `awaiting_review` → `materials_ready` (#981): the filled form was never sent and its browser
 *    session has closed with the run, so carrying the owner's approval to the employer means
 *    filling again. It is as safe as the other two retries and for the same reason — `retryFill`
 *    refuses any application that has already ATTEMPTED a submit — and it is what makes the
 *    approve-and-continue decision reachable from the state the owner is actually looking at.
 */
export const APPLICATION_TRANSITIONS: Readonly<Partial<Record<ApplicationStatus, readonly ApplicationStatus[]>>> = {
	tailoring: ["materials_ready", "blocked", "failed", "cancelled"],
	materials_ready: ["filling", "deferred", "archived"],
	filling: ["awaiting_review", "submitted", "blocked", "failed", "archived"],
	// `blocked → blocked` is permitted from #989: a run that was paused (the application blocked for
	// `supervisor_checkpoint`) can resume and END on a different reason inside one poll interval, and
	// the reason the RUN settled with is the true one. Without this the application kept saying it
	// was waiting for a supervisor decision that had already been made, and the terminal reason —
	// nothing was entered; approve it or apply yourself — never reached the record.
	blocked: ["tailoring", "materials_ready", "filling", "awaiting_review", "submitted", "failed", "deferred", "archived", "blocked"],
	awaiting_review: ["materials_ready", "filling", "deferred", "archived"],
	deferred: ["materials_ready", "archived"],
	failed: ["tailoring", "materials_ready", "archived"],
	cancelled: ["tailoring", "archived"],
};

export function canMoveApplication(from: ApplicationStatus, to: ApplicationStatus): boolean {
	return APPLICATION_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface ApplicationMove {
	to: ApplicationStatus;
	actor: "runner" | "owner" | "system";
	actorInstanceId?: string;
	runId?: string;
	/** Only for `blocked` (and kept as the audit reason for any move). */
	reason?: string | null;
	questions?: string[];
	/** Bind this run as the application's fill run (on `filling` from `materials_ready`). */
	bindRun?: string;
	/** Require the application's bound fill run to be this one. */
	expectRun?: string;
	/** A final submit may have happened — set once, never cleared. */
	submitAttempted?: boolean;
	/** Only with a CONFIRMED submit. */
	submitted?: { at: string; url: string };
	/** Why a terminal archive occurred, retained for durable Scout disposition retries. */
	archiveReason?: string | null;
	/** Bounded evidence reported by the runner for the terminal archive. */
	archiveEvidence?: unknown;
}

/**
 * Move an application — compare-and-set on its status AND state_version, with the audit row
 * written in the same batch (one transaction). The audit insert is guarded by the version the
 * update produced and unique per (application, version), so it lands only for the move that made
 * that version — which is also how success is read back: our audit row exists, or we lost.
 */
export async function moveApplication(env: DB, app: Pick<JobApplication, "id" | "status" | "stateVersion">, userId: string, m: ApplicationMove, now: number): Promise<boolean> {
	if (!canMoveApplication(app.status, m.to)) throw new Error(`An application cannot move from ${app.status} to ${m.to}`);
	const version = app.stateVersion + 1;
	const blocked = m.to === "blocked";
	const auditId = crypto.randomUUID();
	await env.DB.batch([
		env.DB.prepare(
			`UPDATE job_applications
			    SET status = ?1, state_version = ?2, updated_at = ?3,
			        block_reason = ?4, block_questions = ?5,
			        fill_run_id = CASE WHEN ?1 = 'tailoring' THEN NULL ELSE COALESCE(?6, fill_run_id) END,
			        ready_emitted_at = CASE WHEN ?1 = 'tailoring' THEN NULL ELSE ready_emitted_at END,
			        submit_attempted_at = COALESCE(submit_attempted_at, ?7),
			        submitted_at = COALESCE(?8, submitted_at), submitted_url = COALESCE(?9, submitted_url),
			        archive_reason = CASE WHEN ?10 = 'archived' THEN COALESCE(?11, archive_reason) ELSE archive_reason END,
			        archive_evidence = CASE WHEN ?10 = 'archived' THEN COALESCE(?12, archive_evidence) ELSE archive_evidence END
			  WHERE id = ?13 AND user_id = ?14 AND status = ?15 AND state_version = ?16 AND (?17 IS NULL OR fill_run_id = ?17)`,
		).bind(
			m.to,
			version,
			now,
			blocked ? (m.reason ?? null) : null,
			blocked && m.questions?.length ? JSON.stringify(m.questions.slice(0, 20)) : null,
			m.bindRun ?? null,
			m.submitAttempted || m.submitted ? now : null,
			m.submitted?.at ?? null,
			m.submitted?.url ?? null,
			m.to,
			m.archiveReason ?? m.reason ?? null,
			m.archiveEvidence === undefined ? null : JSON.stringify(m.archiveEvidence),
			app.id,
			userId,
			app.status,
			app.stateVersion,
			m.expectRun ?? null,
		),
		env.DB.prepare(
			`INSERT OR IGNORE INTO job_application_events (id, application_id, instance_id, user_id, version, from_status, to_status, actor, actor_instance_id, run_id, reason, created_at)
			 SELECT ?1, ?2, instance_id, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
			   FROM job_applications WHERE id = ?2 AND user_id = ?3 AND state_version = ?4 AND status = ?6`,
		).bind(auditId, app.id, userId, version, app.status, m.to, m.actor, m.actorInstanceId ?? null, m.runId ?? null, m.reason ?? null, now),
	]);
	const moved = !!(await env.DB.prepare("SELECT 1 AS ok FROM job_application_events WHERE id = ?1").bind(auditId).first<{ ok: number }>());
	// The lead the application came from shows its status (#953).
	if (moved) await writeBackToLead(env, userId, app.id);
	return moved;
}

/** Mark that a submit may have happened, whatever the status — the guard against a second one. */
export async function markSubmitAttempted(env: DB, applicationId: string, userId: string, now: number): Promise<void> {
	await env.DB.prepare("UPDATE job_applications SET submit_attempted_at = COALESCE(submit_attempted_at, ?1) WHERE id = ?2 AND user_id = ?3").bind(now, applicationId, userId).run();
}

export interface ApplicationAuditRow {
	version: number;
	from: string;
	to: string;
	actor: string;
	actorInstanceId: string | null;
	runId: string | null;
	reason: string | null;
	at: number;
}

export async function applicationAudit(env: DB, applicationId: string, userId: string): Promise<ApplicationAuditRow[]> {
	const { results } = await env.DB.prepare(
		"SELECT version, from_status, to_status, actor, actor_instance_id, run_id, reason, created_at FROM job_application_events WHERE application_id = ?1 AND user_id = ?2 ORDER BY version",
	)
		.bind(applicationId, userId)
		.all<{ version: number; from_status: string; to_status: string; actor: string; actor_instance_id: string | null; run_id: string | null; reason: string | null; created_at: number }>();
	return (results ?? []).map((r) => ({ version: r.version, from: r.from_status, to: r.to_status, actor: r.actor, actorInstanceId: r.actor_instance_id, runId: r.run_id, reason: r.reason, at: r.created_at }));
}

// ── #1013 bounded live handoff and uncertain-attempt reconciliation ─────────────────────────

/**
 * Durable metadata for a live browser handoff.  `continuityId` is deliberately opaque: the
 * actual browser page, its storage, screenshots, and any entered data remain only in the Runner.
 */
/** Mirrors the Runner contract: requested in cloud, then ready or permanently closed. */
export type LocalApplyHandoffState = "requested" | "ready" | "closed";

export interface LocalApplyHandoff {
	handoffRequestId?: string;
	id: string;
	continuityId: string;
	runId: string;
	applicationId: string;
	instanceId: string;
	/** Existing declared profile label only; never browser state or credentials. */
	browserProfile: string;
	state: LocalApplyHandoffState;
	terminalReason: LocalApplyHandoffTerminalReason | null;
	expiresAt: number;
	createdAt: number;
	activatedAt: number | null;
	endedAt: number | null;
}

interface HandoffRow {
	request_id?: string;
	id: string;
	continuity_id: string;
	run_id: string;
	application_id: string;
	instance_id: string;
	browser_profile: string;
	state: LocalApplyHandoffState;
	terminal_reason: LocalApplyHandoffTerminalReason | null;
	expires_at: number;
	created_at: number;
	activated_at: number | null;
	ended_at: number | null;
}

const presentHandoff = (r: HandoffRow): LocalApplyHandoff => ({
	...(r.request_id && r.request_id !== "legacy" ? { handoffRequestId: r.request_id } : {}),
	id: r.id,
	continuityId: r.continuity_id,
	runId: r.run_id,
	applicationId: r.application_id,
	instanceId: r.instance_id,
	browserProfile: r.browser_profile,
	state: r.state,
	terminalReason: r.terminal_reason,
	expiresAt: r.expires_at,
	createdAt: r.created_at,
	activatedAt: r.activated_at,
	endedAt: r.ended_at,
});

/** True only while the owner can be relayed to the same still-live Runner page. */
export function usableLocalApplyHandoff(handoff: LocalApplyHandoff, now: number): boolean {
	return (handoff.state === "requested" || handoff.state === "ready") && handoff.expiresAt > now;
}

/**
 * Handoff creation is idempotent per exact local-apply run.  The caller has already authenticated
 * the owner, but the binding is checked again here so duplicate taps cannot retarget another run,
 * application, profile, or Runner instance.
 */
export async function createLocalApplyHandoff(
	env: DB,
	input: { run: ApplyRun; app: Pick<JobApplication, "id" | "fillRunId">; userId: string; browserProfile: string; expiresAt: number },
	now: number,
): Promise<LocalApplyHandoff | null> {
	if (!input.browserProfile || input.browserProfile !== input.run.policy.browserProfile || input.app.id !== input.run.applicationId || input.app.fillRunId !== input.run.id || input.expiresAt <= now) return null;
	if (isTerminalApplyRun(input.run.status)) return null;
	const id = crypto.randomUUID();
	const continuityId = crypto.randomUUID();
	const requestId = input.run.pause?.handoffRequestId ?? "legacy";
	// Only a new, durably recorded pause supersedes an earlier handoff. Preserve the old row.
	await env.DB.prepare(`UPDATE local_apply_handoffs SET state = 'closed', terminal_reason = 'unavailable', ended_at = ?1, updated_at = ?1
		WHERE run_id = ?2 AND instance_id = ?3 AND user_id = ?4 AND request_id <> ?5 AND state IN ('requested', 'ready')
		AND EXISTS (SELECT 1 FROM local_apply_runs r WHERE r.id = ?2 AND r.status = 'paused' AND json_extract(r.pause, '$.handoffRequestId') = ?5)`)
		.bind(now, input.run.id, input.run.instanceId, input.userId, requestId).run();
	await env.DB.prepare(
		`INSERT INTO local_apply_handoffs
		   (id, continuity_id, run_id, application_id, instance_id, user_id, browser_profile, state, expires_at, created_at, updated_at, request_id)
		 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'requested', ?8, ?9, ?9, ?10
		   FROM local_apply_runs r
		  WHERE r.id = ?3 AND r.instance_id = ?5 AND r.user_id = ?6 AND r.application_id = ?4
		    AND r.status IN ('queued', 'running', 'paused')
		    AND json_extract(r.policy, '$.browserProfile') = ?7
		    AND COALESCE(json_extract(r.pause, '$.handoffRequestId'), 'legacy') = ?10
		    AND EXISTS (SELECT 1 FROM job_applications a WHERE a.id = ?4 AND a.user_id = ?6 AND a.fill_run_id = ?3)
		 ON CONFLICT(run_id, request_id) DO NOTHING`,
	)
		.bind(id, continuityId, input.run.id, input.app.id, input.run.instanceId, input.userId, input.browserProfile, input.expiresAt, now, requestId)
		.run();
	const row = await env.DB.prepare(
		"SELECT * FROM local_apply_handoffs WHERE run_id = ?1 AND instance_id = ?2 AND user_id = ?3 AND application_id = ?4 AND browser_profile = ?5 AND request_id = ?6",
	)
		.bind(input.run.id, input.run.instanceId, input.userId, input.app.id, input.browserProfile, requestId)
		.first<HandoffRow>();
	return row ? presentHandoff(row) : null;
}

/** Resolve an opaque handoff only inside the exact owner's Runner instance. */
export async function getHandoffById(env: DB, instanceId: string, userId: string, continuityId: string): Promise<LocalApplyHandoff | null> {
	const row = await env.DB.prepare("SELECT * FROM local_apply_handoffs WHERE continuity_id = ?1 AND instance_id = ?2 AND user_id = ?3")
		.bind(continuityId, instanceId, userId)
		.first<HandoffRow>();
	return row ? presentHandoff(row) : null;
}

export async function getLocalApplyHandoffForRun(env: DB, runId: string, instanceId: string, userId: string): Promise<LocalApplyHandoff | null> {
	const row = await env.DB.prepare("SELECT * FROM local_apply_handoffs WHERE run_id = ?1 AND instance_id = ?2 AND user_id = ?3 ORDER BY created_at DESC, rowid DESC LIMIT 1")
		.bind(runId, instanceId, userId)
		.first<HandoffRow>();
	return row ? presentHandoff(row) : null;
}

/**
 * Advance a handoff only while it is active.  A closed handoff never becomes ready again: a Runner
 * restart or destroyed page is a closed terminal reason, never a successful takeover.
 */
export async function markLocalApplyHandoff(
	env: DB,
	input: { continuityId: string; instanceId: string; userId: string; state: Exclude<LocalApplyHandoffState, "requested">; terminalReason?: LocalApplyHandoffTerminalReason },
	now: number,
): Promise<LocalApplyHandoff | null> {
	if ((input.state === "closed") !== !!input.terminalReason) return null;
	const res = await env.DB.prepare(
		`UPDATE local_apply_handoffs
		    SET state = ?1, terminal_reason = ?2,
		        activated_at = CASE WHEN ?1 = 'ready' AND activated_at IS NULL THEN ?3 ELSE activated_at END,
		        ended_at = CASE WHEN ?1 = 'closed' THEN ?3 ELSE ended_at END, updated_at = ?3
		  WHERE continuity_id = ?4 AND instance_id = ?5 AND user_id = ?6
		    AND state IN ('requested', 'ready')
		    AND (?1 <> 'ready' OR expires_at > ?3)`,
	)
		.bind(input.state, input.terminalReason ?? null, now, input.continuityId, input.instanceId, input.userId)
		.run();
	if ((res.meta?.changes ?? 0) === 0) return null;
	return getHandoffById(env, input.instanceId, input.userId, input.continuityId);
}


// ── Runs ─────────────────────────────────────────────────────────────────────────────────────

export type ApplyRunStatus = "queued" | "running" | "paused" | "awaiting_review" | "submitted" | "blocked" | "failed" | "cancelled";
const TERMINAL: readonly ApplyRunStatus[] = ["awaiting_review", "submitted", "blocked", "failed", "cancelled"];
export const isTerminalApplyRun = (s: ApplyRunStatus) => TERMINAL.includes(s);

export interface ApplyRunPolicy {
	toolAccess?: import("./contract.js").LocalApplyToolAccess;
	toolAccessAcceptance?: import("./contract.js").LocalApplyToolAccessAcceptance | null;
	/** Frozen at creation; older runs retain conservative escalation. */
	escalationLevel?: import("./contract.js").LocalApplyEscalationLevel;
	browserWebsiteAccess?: BrowserWebsiteAccessWire;
	/** Native caller deadline in seconds, fixed when the run is created. */
	browserCommandTimeoutSeconds?: number;
	engine: string;
	model?: string | null;
	reasoningEffort?: string | null;
	authMode: string;
	browserProfile: string;
	mode: LocalApplyMode;
	allowDomains: string[];
	/** `stallMinutes` from #1107; absent on a run recorded before it, which reads as automatic. */
	limits: { maxMinutes: number; maxPages: number; maxActions: number; stallMinutes?: number | null };
	gate: { allowed: boolean; gateId: string | null; checks: GateCheck[] };
	/** Durable #1011 recovery claim, never exposed to the browser envelope. */
	approvalRecoveryId?: string;
	/** Present only when the owner's browser-screenshot switch was OFF as this run started (#1064). */
	screenshots?: false;
	/** Owner screenshot blurring choice, frozen when the run starts; absent = true. */
	blurFormFields?: boolean;
}

export type { ApplyTraceEvent } from "./trace-integrity.js";

export interface ApplyRun {
	id: string;
	instanceId: string;
	applicationId: string;
	requestId: string;
	status: ApplyRunStatus;
	policy: ApplyRunPolicy;
	pause: LocalApplyPause | null;
	result: unknown;
	engineAuth: string | null;
	errorCode: string | null;
	error: string | null;
	runnerNode: string | null;
	/** The CLI that executed this run, from the machine's own registration (#977). */
	runnerVersion: string | null;
	trace: ApplyTraceEvent[];
	runnerSeq: number;
	lastSyncedAt: number | null;
	createdAt: number;
	startedAt: number | null;
	/** Durable active time; paused owner waits never consume the execution budget. */
	activeElapsedMs?: number;
	activeStartedAt?: number | null;
	endedAt: number | null;
}

interface RunRow {
	id: string;
	instance_id: string;
	application_id: string;
	request_id: string;
	status: ApplyRunStatus;
	policy: string;
	pause: string | null;
	result: string | null;
	engine_auth: string | null;
	error_code: string | null;
	error: string | null;
	runner_node: string | null;
	runner_version: string | null;
	trace: string;
	runner_seq: number;
	last_synced_at: number | null;
	created_at: number;
	started_at: number | null;
	active_elapsed_ms: number;
	active_started_at: number | null;
	ended_at: number | null;
}

const json = <T>(s: string | null): T | null => {
	if (!s) return null;
	try {
		return JSON.parse(s) as T;
	} catch {
		return null;
	}
};

/**
 * A stored URL as a reader may see it (#1069): origin and path. Rows written before the write path
 * reduced them still hold the full page URL — a sign-in page's OAuth state, nonce, PKCE challenge and
 * session ids — and are reduced here, on every read, instead of being rewritten or purged.
 */
const safeUrl = (v: unknown): string | undefined => (typeof v === "string" && v ? traceUrl(v) || undefined : undefined);
function withSafeUrl<T extends object>(o: T | null | undefined): T | null {
	if (!o || typeof o !== "object") return o ?? null;
	const rec = o as Record<string, unknown>;
	if (!("url" in rec)) return o;
	const { url, ...rest } = rec;
	const kept = safeUrl(url);
	return (kept ? { ...rest, url: kept } : rest) as T;
}
function safeResult(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return raw;
	const r = raw as Record<string, unknown>;
	return { ...r, ...(r.submitted ? { submitted: withSafeUrl(r.submitted as object) } : {}), ...(r.unavailable ? { unavailable: withSafeUrl(r.unavailable as object) } : {}) };
}

const present = (r: RunRow): ApplyRun => ({
	id: r.id,
	instanceId: r.instance_id,
	applicationId: r.application_id,
	requestId: r.request_id,
	status: r.status,
	policy: json<ApplyRunPolicy>(r.policy) as ApplyRunPolicy,
	pause: withSafeUrl(json<LocalApplyPause>(r.pause)),
	result: safeResult(json(r.result)),
	engineAuth: r.engine_auth,
	errorCode: r.error_code,
	error: r.error,
	runnerNode: r.runner_node,
	runnerVersion: r.runner_version ?? null,
	trace: (json<ApplyTraceEvent[]>(r.trace) ?? []).map((e) => withSafeUrl(e) as ApplyTraceEvent),
	runnerSeq: Number(r.runner_seq ?? 0),
	lastSyncedAt: r.last_synced_at,
	createdAt: r.created_at,
	startedAt: r.started_at,
	activeElapsedMs: r.active_elapsed_ms ?? 0,
	activeStartedAt: r.active_started_at ?? null,
	endedAt: r.ended_at,
});

export async function getApplyRun(env: DB, instanceId: string, userId: string, id: string): Promise<ApplyRun | null> {
	const row = await env.DB.prepare("SELECT * FROM local_apply_runs WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3").bind(id, instanceId, userId).first<RunRow>();
	return row ? present(row) : null;
}

export async function getApplyRunByRequest(env: DB, instanceId: string, userId: string, requestId: string): Promise<ApplyRun | null> {
	const row = await env.DB.prepare("SELECT * FROM local_apply_runs WHERE instance_id = ?1 AND user_id = ?2 AND request_id = ?3").bind(instanceId, userId, requestId).first<RunRow>();
	return row ? present(row) : null;
}

export async function listApplyRuns(env: DB, instanceId: string, userId: string, limit: number): Promise<ApplyRun[]> {
	const { results } = await env.DB.prepare("SELECT * FROM local_apply_runs WHERE instance_id = ?1 AND user_id = ?2 ORDER BY created_at DESC, id DESC LIMIT ?3").bind(instanceId, userId, limit).all<RunRow>();
	return (results ?? []).map(present);
}

/** Insert a queued run; a request id already held returns false (the caller reads the existing one). */
export async function insertApplyRun(env: DB, r: { id: string; instanceId: string; userId: string; applicationId: string; requestId: string; policy: ApplyRunPolicy; trace: ApplyTraceEvent[]; now: number; runnerVersion?: string | null }): Promise<boolean> {
	const res = await env.DB.prepare(
		`INSERT INTO local_apply_runs (id, instance_id, user_id, application_id, request_id, status, policy, trace, created_at, updated_at, runner_version)
		 VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?7, ?8, ?8, ?9)
		 ON CONFLICT(instance_id, request_id) DO NOTHING`,
	)
		.bind(r.id, r.instanceId, r.userId, r.applicationId, r.requestId, JSON.stringify(r.policy), JSON.stringify(r.trace), r.now, r.runnerVersion ?? null)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

/**
 * The run row keeps the NEWEST this many trace events (#1108). It kept the first 500 and silently
 * dropped every later one, so past 500 a long fill stopped recording exactly where it was going —
 * its end. The card's action log (`task-action-log.ts`) is the unbounded record of the run's steps.
 */
export { MAX_APPLY_TRACE } from "./trace-integrity.js";
/** Atomic trace append with status/cursor fences (#1524). Null when stale or invalid. */
export async function updateApplyRun(
	env: DB,
	run: ApplyRun,
	u: { to?: ApplyRunStatus; pause?: LocalApplyPause | null; result?: unknown; engineAuth?: string | null; errorCode?: string | null; error?: string | null; runnerNode?: string | null; events?: ApplyTraceEvent[]; runnerSeq?: number; expectedRunnerSeq?: number; policy?: ApplyRunPolicy },
	now: number,
): Promise<ApplyRun | null> {
	const to = u.to ?? run.status;
	if (!validTraceAppend(u.events ?? [], u.runnerSeq)) return null;
	const res = await env.DB.prepare(
		`UPDATE local_apply_runs
		    SET status = ?1, pause = CASE WHEN ?2 THEN ?3 ELSE pause END, result = COALESCE(?4, result), engine_auth = COALESCE(?5, engine_auth),
		        error_code = COALESCE(?6, error_code), error = COALESCE(?7, error), runner_node = COALESCE(?8, runner_node), trace = ${APPEND_APPLY_TRACE_SQL},
		        runner_seq = MAX(runner_seq, ?10), last_synced_at = CASE WHEN ?11 THEN ?12 ELSE last_synced_at END,
		        active_elapsed_ms = active_elapsed_ms + CASE WHEN status = 'running' AND ?1 != 'running' THEN MAX(0, ?12 - COALESCE(active_started_at, ?12)) ELSE 0 END,
		        active_started_at = CASE WHEN ?1 = 'running' THEN COALESCE(active_started_at, ?12) ELSE NULL END,
		        started_at = CASE WHEN ?1 = 'running' AND started_at IS NULL THEN ?12 ELSE started_at END,
		        ended_at = CASE WHEN ?13 THEN ?12 ELSE ended_at END, policy = COALESCE(?17, policy), updated_at = ?12
		  WHERE id = ?14 AND instance_id = ?15 AND status = ?16 AND (?11 = 0 OR runner_seq <= ?10) AND (?18 IS NULL OR runner_seq = ?18)`,
	)
		.bind(
			to,
			u.pause !== undefined ? 1 : 0,
			u.pause ? JSON.stringify(u.pause) : null,
			u.result === undefined ? null : JSON.stringify(u.result),
			u.engineAuth ?? null,
			u.errorCode ?? null,
			u.error ?? null,
			u.runnerNode ?? null,
			JSON.stringify(u.events ?? []),
			u.runnerSeq ?? 0,
			u.runnerSeq !== undefined ? 1 : 0,
			now,
			isTerminalApplyRun(to) && !isTerminalApplyRun(run.status) ? 1 : 0,
			run.id,
			run.instanceId,
			run.status,
			// The run's own policy is rewritten in exactly one case (#993): a queued run whose
			// approval earns `auto_submit` once the machine is free. `COALESCE` keeps every other
			// update from touching it, so the column still cannot drift behind the envelope the
			// runner was given — that pairing is why the mode is persisted at all.
			u.policy === undefined ? null : JSON.stringify(u.policy), u.expectedRunnerSeq ?? null,
		)
		.run();
	if ((res.meta?.changes ?? 0) === 0) return null;
	const row = await env.DB.prepare("SELECT * FROM local_apply_runs WHERE id = ?1 AND instance_id = ?2").bind(run.id, run.instanceId).first<RunRow>();
	return row ? present(row) : null;
}

export async function activeApplyRuns(env: DB, limit: number): Promise<Array<{ id: string; instanceId: string; userId: string }>> {
	// A runner result is committed before its application projection.  The second arm repairs the
	// narrow crash window between those two durable writes; it cannot revive ordinary terminal
	// history because only an application still at `filling` is eligible.
	const { results } = await env.DB.prepare(`SELECT r.id, r.instance_id, r.user_id
		FROM local_apply_runs r
		WHERE r.status IN ('queued', 'running', 'paused')
		   OR (r.result IS NOT NULL AND EXISTS (
			SELECT 1 FROM job_applications a WHERE a.id = r.application_id AND a.user_id = r.user_id AND a.status = 'filling'
		   ))
		ORDER BY CASE WHEN r.status IN ('queued', 'running', 'paused') THEN 0 ELSE 1 END, COALESCE(r.last_synced_at, 0) LIMIT ?1`)
		.bind(limit)
		.all<{ id: string; instance_id: string; user_id: string }>();
	return (results ?? []).map((r) => ({ id: r.id, instanceId: r.instance_id, userId: r.user_id }));
}

/** What the gate counts: open runs, and auto_submit runs dispatched in the last 24h. */
/**
 * `opts` exists for the dequeue path (#993), and only for it.
 *
 * `excludeRunId` — the run being evaluated must not count itself. A queued run IS a row with
 * status `queued`, so re-evaluating its own gate at dispatch found `active >= 1` and refused
 * `concurrency` for ever: the queued run could never be upgraded to the mode its approval had
 * already earned, however long it waited.
 *
 * `machineOnly` — count only the statuses that actually HOLD the machine. `queued` belongs in the
 * count for a first dispatch (a new application should not auto-submit past a line of waiting
 * ones), but at dequeue the queue has just proven the slot free, and counting siblings still in
 * line would reinstate the same deadlock the moment two applications were approved together —
 * which is the case #974 was filed about.
 */
export async function applyRunCounts(
	env: DB,
	instanceId: string,
	userId: string,
	now: number,
	opts: { excludeRunId?: string; machineOnly?: boolean } = {},
): Promise<{ active: number; autoSubmitsToday: number }> {
	const statuses = opts.machineOnly ? "('running', 'paused')" : "('queued', 'running', 'paused')";
	const row = await env.DB.prepare(
		`SELECT SUM(CASE WHEN status IN ${statuses} AND id <> ?4 THEN 1 ELSE 0 END) AS active,
		        SUM(CASE WHEN json_extract(policy, '$.mode') = 'auto_submit' AND created_at >= ?3 AND id <> ?4 THEN 1 ELSE 0 END) AS auto_today
		   FROM local_apply_runs WHERE instance_id = ?1 AND user_id = ?2`,
	)
		.bind(instanceId, userId, now - 86_400_000, opts.excludeRunId ?? "")
		.first<{ active: number | null; auto_today: number | null }>();
	return { active: Number(row?.active ?? 0), autoSubmitsToday: Number(row?.auto_today ?? 0) };
}
