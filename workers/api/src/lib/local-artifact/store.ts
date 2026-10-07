/**
 * Application Tailor — settings and D1 reads/writes (#956). Every statement is scoped by
 * `instance_id` AND `user_id`, so a missed ownership check cannot become a cross-tenant read.
 */
import type { Env } from "../../types.js";
import {
	LOCAL_ARTIFACT_AUTH_MODES,
	LOCAL_ARTIFACT_ENGINES,
	type LocalArtifactAuthMode,
	type LocalArtifactEngine,
	type LocalArtifactEvent,
	type LocalArtifactFile,
	type LocalArtifactSource,
	type LocalArtifactSourceRole,
	isHomeRelative,
	isWorkspaceRelative,
} from "./contract.js";

type DB = Pick<Env, "DB">;

// ── Settings (agent_instances.config.applicationTailor) ──────────────────────────────────────

export interface ApplicationTailorSettings {
	engine: LocalArtifactEngine;
	authMode: LocalArtifactAuthMode;
	/** `~/…` — the folder holding the owner's sources; artifacts go to its `applications/`. */
	workspace: string;
	/** Paths relative to the workspace. `resume` and `profile` are required for a run. */
	sources: Partial<Record<LocalArtifactSourceRole, string>>;
	/** Days to keep a generated folder; 0 = until the owner deletes it. */
	retainDays: number;
	maxMinutes: number;
}

export const TAILOR_DEFAULTS: ApplicationTailorSettings = {
	engine: "claude",
	authMode: "machine",
	workspace: "~/jobs",
	sources: { resume: "resume.md", profile: "profile.md" },
	retainDays: 0,
	maxMinutes: 10,
};
export const TAILOR_SETTINGS_KEY = "applicationTailor";

/**
 * Merge a patch over the current settings, REFUSING (never clamping) anything out of bounds. A
 * provider API key mode does not exist here, so `authMode: "api-key"` is refused like any typo.
 */
export function mergeTailorSettings(current: ApplicationTailorSettings, patch: unknown): { settings: ApplicationTailorSettings } | { error: string } {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { error: "settings must be an object" };
	const p = patch as Record<string, unknown>;
	const next: ApplicationTailorSettings = { ...current, sources: { ...current.sources } };
	if (p.engine !== undefined) {
		if (!LOCAL_ARTIFACT_ENGINES.includes(p.engine as LocalArtifactEngine)) return { error: `engine must be one of ${LOCAL_ARTIFACT_ENGINES.join(", ")}` };
		next.engine = p.engine as LocalArtifactEngine;
	}
	if (p.authMode !== undefined) {
		if (!LOCAL_ARTIFACT_AUTH_MODES.includes(p.authMode as LocalArtifactAuthMode)) {
			return { error: `authMode must be ${LOCAL_ARTIFACT_AUTH_MODES.join(" or ")} — the Application Tailor runs on the machine's own sign-in and never on a provider API key` };
		}
		next.authMode = p.authMode as LocalArtifactAuthMode;
	}
	if (p.workspace !== undefined) {
		if (typeof p.workspace !== "string" || !isHomeRelative(p.workspace.trim())) return { error: 'workspace must be a folder under the home folder, written "~/…" (no "..")' };
		next.workspace = p.workspace.trim();
	}
	if (p.sources !== undefined) {
		if (!p.sources || typeof p.sources !== "object" || Array.isArray(p.sources)) return { error: "sources must be an object of role → path" };
		for (const [role, path] of Object.entries(p.sources as Record<string, unknown>)) {
			if (role !== "resume" && role !== "profile" && role !== "answers") return { error: `unknown source role "${role}" (resume, profile, answers)` };
			if (path === null || path === "") {
				delete next.sources[role];
				continue;
			}
			if (typeof path !== "string" || !isWorkspaceRelative(path.trim())) return { error: `source ${role} must be a path inside the workspace (relative, no "..")` };
			if (path.trim().split("/")[0] === "applications") return { error: `source ${role} may not be inside applications/, where generated material lives` };
			next.sources[role] = path.trim();
		}
	}
	for (const [key, min, max] of [["retainDays", 0, 3650], ["maxMinutes", 1, 60]] as const) {
		if (p[key] === undefined) continue;
		const v = p[key];
		if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return { error: `${key} must be a whole number from ${min} to ${max}` };
		next[key] = v;
	}
	return { settings: next };
}

/** The stored settings over the defaults. A stored block that no longer validates reads as the reason. */
export function effectiveTailorSettings(stored: unknown): { settings: ApplicationTailorSettings } | { error: string } {
	return stored === undefined || stored === null ? { settings: TAILOR_DEFAULTS } : mergeTailorSettings(TAILOR_DEFAULTS, stored);
}

export function sourcesOf(s: ApplicationTailorSettings): LocalArtifactSource[] {
	return (["resume", "profile", "answers"] as const).filter((r) => s.sources[r]).map((role) => ({ role, path: s.sources[role] as string }));
}

// ── Applications ─────────────────────────────────────────────────────────────────────────────

export type ApplicationStatus = "tailoring" | "materials_ready" | "blocked" | "failed" | "cancelled";

export interface JobApplication {
	id: string;
	instanceId: string;
	sourceInstanceId: string;
	leadId: string;
	lifecycleVersion: number;
	idempotencyKey: string;
	status: ApplicationStatus;
	lead: unknown;
	tailoringRunId: string | null;
	resumeArtifact: LocalArtifactFile | null;
	coverLetterArtifact: LocalArtifactFile | null;
	profileVersion: string | null;
	generatedAt: string | null;
	blockReason: string | null;
	blockQuestions: string[];
	readyEvent: Record<string, unknown> | null;
	readyEmittedAt: number | null;
	createdAt: number;
	updatedAt: number;
}

interface AppRow {
	id: string;
	instance_id: string;
	user_id: string;
	source_instance_id: string;
	lead_id: string;
	lifecycle_version: number;
	idempotency_key: string;
	status: ApplicationStatus;
	lead: string;
	tailoring_run_id: string | null;
	resume_artifact: string | null;
	cover_letter_artifact: string | null;
	profile_version: string | null;
	generated_at: string | null;
	block_reason: string | null;
	block_questions: string | null;
	ready_event: string | null;
	ready_emitted_at: number | null;
	created_at: number;
	updated_at: number;
}

const json = <T>(s: string | null): T | null => {
	if (!s) return null;
	try {
		return JSON.parse(s) as T;
	} catch {
		return null;
	}
};

const presentApp = (r: AppRow): JobApplication => ({
	id: r.id,
	instanceId: r.instance_id,
	sourceInstanceId: r.source_instance_id,
	leadId: r.lead_id,
	lifecycleVersion: r.lifecycle_version,
	idempotencyKey: r.idempotency_key,
	status: r.status,
	lead: json(r.lead),
	tailoringRunId: r.tailoring_run_id,
	resumeArtifact: json(r.resume_artifact),
	coverLetterArtifact: json(r.cover_letter_artifact),
	profileVersion: r.profile_version,
	generatedAt: r.generated_at,
	blockReason: r.block_reason,
	blockQuestions: json<string[]>(r.block_questions) ?? [],
	readyEvent: json(r.ready_event),
	readyEmittedAt: r.ready_emitted_at,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

export async function getApplication(env: DB, instanceId: string, userId: string, id: string): Promise<JobApplication | null> {
	const row = await env.DB.prepare("SELECT * FROM job_applications WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3").bind(id, instanceId, userId).first<AppRow>();
	return row ? presentApp(row) : null;
}

export async function getApplicationByKey(env: DB, instanceId: string, userId: string, key: string): Promise<JobApplication | null> {
	const row = await env.DB.prepare("SELECT * FROM job_applications WHERE instance_id = ?1 AND user_id = ?2 AND idempotency_key = ?3").bind(instanceId, userId, key).first<AppRow>();
	return row ? presentApp(row) : null;
}

export async function listApplications(env: DB, instanceId: string, userId: string, opts: { status?: ApplicationStatus; limit: number }): Promise<JobApplication[]> {
	const { results } = await env.DB.prepare(
		`SELECT * FROM job_applications WHERE instance_id = ?1 AND user_id = ?2 AND (?3 IS NULL OR status = ?3) ORDER BY created_at DESC, id DESC LIMIT ?4`,
	)
		.bind(instanceId, userId, opts.status ?? null, opts.limit)
		.all<AppRow>();
	return (results ?? []).map(presentApp);
}

/**
 * Create the application for one approved lead version — or return the one that already exists.
 * `ON CONFLICT DO NOTHING` on the idempotency key, so two deliveries racing on the same event
 * cannot both create one.
 */
export async function claimApplication(
	env: DB,
	a: {
		id: string;
		instanceId: string;
		userId: string;
		sourceInstanceId: string;
		leadId: string;
		lifecycleVersion: number;
		key: string;
		lead: unknown;
		status: "tailoring" | "blocked";
		blockReason?: string;
		blockQuestions?: string[];
		now: number;
	},
): Promise<{ created: boolean; app: JobApplication }> {
	const res = await env.DB.prepare(
		`INSERT INTO job_applications (id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, status, lead, block_reason, block_questions, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
		 ON CONFLICT(instance_id, idempotency_key) DO NOTHING`,
	)
		.bind(
			a.id,
			a.instanceId,
			a.userId,
			a.sourceInstanceId,
			a.leadId,
			a.lifecycleVersion,
			a.key,
			a.status,
			JSON.stringify(a.lead ?? null),
			a.blockReason ?? null,
			a.blockQuestions ? JSON.stringify(a.blockQuestions) : null,
			a.now,
		)
		.run();
	const app = (await getApplicationByKey(env, a.instanceId, a.userId, a.key)) as JobApplication;
	return { created: (res.meta?.changes ?? 0) > 0, app };
}

export interface ApplicationSettle {
	to: "materials_ready" | "blocked" | "failed" | "cancelled";
	resumeArtifact?: LocalArtifactFile;
	coverLetterArtifact?: LocalArtifactFile;
	profileVersion?: string | null;
	generatedAt?: string | null;
	blockReason?: string | null;
	blockQuestions?: string[];
	readyEvent?: Record<string, unknown>;
}

/**
 * Move an application out of `tailoring` — compare-and-set, so the transition (and the ready event
 * written with it) happens exactly once however many syncs observe the same finished run.
 */
export async function settleApplication(env: DB, instanceId: string, userId: string, id: string, runId: string, s: ApplicationSettle, now: number): Promise<boolean> {
	const res = await env.DB.prepare(
		`UPDATE job_applications
		    SET status = ?1, resume_artifact = ?2, cover_letter_artifact = ?3, profile_version = ?4, generated_at = ?5,
		        block_reason = ?6, block_questions = ?7, ready_event = ?8, updated_at = ?9
		  WHERE id = ?10 AND instance_id = ?11 AND user_id = ?12 AND status = 'tailoring' AND tailoring_run_id = ?13`,
	)
		.bind(
			s.to,
			s.resumeArtifact ? JSON.stringify(s.resumeArtifact) : null,
			s.coverLetterArtifact ? JSON.stringify(s.coverLetterArtifact) : null,
			s.profileVersion ?? null,
			s.generatedAt ?? null,
			s.blockReason ?? null,
			s.blockQuestions?.length ? JSON.stringify(s.blockQuestions) : null,
			s.readyEvent ? JSON.stringify(s.readyEvent) : null,
			now,
			id,
			instanceId,
			userId,
			runId,
		)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

export async function markReadyEmitted(env: DB, id: string, now: number): Promise<void> {
	await env.DB.prepare("UPDATE job_applications SET ready_emitted_at = ?1 WHERE id = ?2 AND ready_emitted_at IS NULL").bind(now, id).run();
}

/** Ready applications whose event is not yet in the outbox — the crash-between-the-two backstop. */
export async function unemittedReadyApplications(env: DB, limit: number): Promise<Array<{ id: string; instanceId: string; userId: string }>> {
	const { results } = await env.DB.prepare("SELECT id, instance_id, user_id FROM job_applications WHERE status = 'materials_ready' AND ready_emitted_at IS NULL LIMIT ?1")
		.bind(limit)
		.all<{ id: string; instance_id: string; user_id: string }>();
	return (results ?? []).map((r) => ({ id: r.id, instanceId: r.instance_id, userId: r.user_id }));
}

// ── Runs ─────────────────────────────────────────────────────────────────────────────────────

export type TailorRunStatus = "queued" | "running" | "completed" | "needs_human" | "failed" | "cancelled";
const TERMINAL: readonly TailorRunStatus[] = ["completed", "needs_human", "failed", "cancelled"];
export const isTerminalRun = (s: TailorRunStatus) => TERMINAL.includes(s);

export interface TailorRunPolicy {
	engine: LocalArtifactEngine;
	authMode: LocalArtifactAuthMode;
	workspace: string;
	sources: LocalArtifactSource[];
	retainDays: number;
	maxMinutes: number;
}

export type TraceEvent = Omit<LocalArtifactEvent, "type"> & { type: LocalArtifactEvent["type"] | "run.requested" | "runner.dispatched" | "run.ended" };

export interface TailorRun {
	id: string;
	instanceId: string;
	applicationId: string;
	requestId: string;
	status: TailorRunStatus;
	policy: TailorRunPolicy;
	result: unknown;
	engineAuth: string | null;
	errorCode: string | null;
	error: string | null;
	runnerNode: string | null;
	trace: TraceEvent[];
	runnerSeq: number;
	lastSyncedAt: number | null;
	createdAt: number;
	startedAt: number | null;
	endedAt: number | null;
}

interface RunRow {
	id: string;
	instance_id: string;
	application_id: string;
	request_id: string;
	status: TailorRunStatus;
	policy: string;
	result: string | null;
	engine_auth: string | null;
	error_code: string | null;
	error: string | null;
	runner_node: string | null;
	trace: string;
	runner_seq: number;
	last_synced_at: number | null;
	created_at: number;
	started_at: number | null;
	ended_at: number | null;
}

const presentRun = (r: RunRow): TailorRun => ({
	id: r.id,
	instanceId: r.instance_id,
	applicationId: r.application_id,
	requestId: r.request_id,
	status: r.status,
	policy: json<TailorRunPolicy>(r.policy) as TailorRunPolicy,
	result: json(r.result),
	engineAuth: r.engine_auth,
	errorCode: r.error_code,
	error: r.error,
	runnerNode: r.runner_node,
	trace: json<TraceEvent[]>(r.trace) ?? [],
	runnerSeq: Number(r.runner_seq ?? 0),
	lastSyncedAt: r.last_synced_at,
	createdAt: r.created_at,
	startedAt: r.started_at,
	endedAt: r.ended_at,
});

export async function getTailorRun(env: DB, instanceId: string, userId: string, id: string): Promise<TailorRun | null> {
	const row = await env.DB.prepare("SELECT * FROM local_artifact_runs WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3").bind(id, instanceId, userId).first<RunRow>();
	return row ? presentRun(row) : null;
}

/** Insert a queued run and link it to its application, in one batch. */
export async function createTailorRun(env: DB, r: { id: string; instanceId: string; userId: string; applicationId: string; requestId: string; policy: TailorRunPolicy; trace: TraceEvent[]; now: number }): Promise<void> {
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO local_artifact_runs (id, instance_id, user_id, application_id, request_id, status, policy, trace, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?7, ?8, ?8)`,
		).bind(r.id, r.instanceId, r.userId, r.applicationId, r.requestId, JSON.stringify(r.policy), JSON.stringify(r.trace), r.now),
		env.DB.prepare("UPDATE job_applications SET tailoring_run_id = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4").bind(r.id, r.now, r.applicationId, r.userId),
	]);
}

export const MAX_TRACE = 200;

/**
 * Move a run — compare-and-set on the status it was read in — appending trace events and moving
 * the runner cursor in the same statement. Null when the move lost a race.
 */
export async function updateTailorRun(
	env: DB,
	run: TailorRun,
	u: { to?: TailorRunStatus; result?: unknown; engineAuth?: string | null; errorCode?: string | null; error?: string | null; runnerNode?: string | null; events?: TraceEvent[]; runnerSeq?: number },
	now: number,
): Promise<TailorRun | null> {
	const to = u.to ?? run.status;
	const trace = [...run.trace, ...(u.events ?? [])].slice(0, MAX_TRACE);
	const res = await env.DB.prepare(
		`UPDATE local_artifact_runs
		    SET status = ?1, result = COALESCE(?2, result), engine_auth = COALESCE(?3, engine_auth), error_code = COALESCE(?4, error_code),
		        error = COALESCE(?5, error), runner_node = COALESCE(?6, runner_node), trace = ?7, runner_seq = MAX(runner_seq, ?8),
		        last_synced_at = CASE WHEN ?9 THEN ?10 ELSE last_synced_at END,
		        started_at = CASE WHEN ?1 = 'running' AND started_at IS NULL THEN ?10 ELSE started_at END,
		        ended_at = CASE WHEN ?11 THEN ?10 ELSE ended_at END, updated_at = ?10
		  WHERE id = ?12 AND instance_id = ?13 AND status = ?14`,
	)
		.bind(
			to,
			u.result === undefined ? null : JSON.stringify(u.result),
			u.engineAuth ?? null,
			u.errorCode ?? null,
			u.error ?? null,
			u.runnerNode ?? null,
			JSON.stringify(trace),
			u.runnerSeq ?? 0,
			u.runnerSeq !== undefined ? 1 : 0,
			now,
			isTerminalRun(to) && !isTerminalRun(run.status) ? 1 : 0,
			run.id,
			run.instanceId,
			run.status,
		)
		.run();
	if ((res.meta?.changes ?? 0) === 0) return null;
	const row = await env.DB.prepare("SELECT * FROM local_artifact_runs WHERE id = ?1 AND instance_id = ?2").bind(run.id, run.instanceId).first<RunRow>();
	return row ? presentRun(row) : null;
}

/** Active runs, least recently synced first — what the cron reads from the runners. */
export async function activeTailorRuns(env: DB, limit: number): Promise<Array<{ id: string; instanceId: string; userId: string }>> {
	const { results } = await env.DB.prepare("SELECT id, instance_id, user_id FROM local_artifact_runs WHERE status IN ('queued', 'running') ORDER BY COALESCE(last_synced_at, 0) LIMIT ?1")
		.bind(limit)
		.all<{ id: string; instance_id: string; user_id: string }>();
	return (results ?? []).map((r) => ({ id: r.id, instanceId: r.instance_id, userId: r.user_id }));
}
