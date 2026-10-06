/**
 * Local CLI browser research — D1 reads and writes (#945). Every statement is scoped by
 * `instance_id` AND `user_id`; the routes have already checked ownership, and this keeps a missed
 * check from becoming a cross-tenant read.
 */
import type { Env } from "../../types.js";
import { sqlLiteralList } from "../sql.js";
import type { LocalBrowserEvent, LocalBrowserPlatformEventType, LocalBrowserResultEnvelope } from "./contract.js";
import { ACTIVE_RUN_STATUSES, type EffectiveLocalBrowserPolicy, type LocalBrowserRunStatus, type LocalBrowserSettings, canTransition } from "./policy.js";

type DB = Pick<Env, "DB">;

/** A run as the API returns it. */
export interface LocalBrowserRun {
	id: string;
	instanceId: string;
	requestId: string;
	objective: string;
	status: LocalBrowserRunStatus;
	pauseReason: string | null;
	errorCode: string | null;
	error: string | null;
	policy: EffectiveLocalBrowserPolicy;
	result: LocalBrowserResultEnvelope | null;
	engineAuth: string | null;
	runnerNode: string | null;
	runnerTaskId: string | null;
	/** The last runner event seq stored — the next pull's `afterSeq` (#944). */
	runnerSeq: number;
	/** When the runner last answered for this run. */
	lastSyncedAt: number | null;
	createdAt: number;
	startedAt: number | null;
	endedAt: number | null;
	updatedAt: number;
}

interface RunRow {
	id: string;
	instance_id: string;
	request_id: string;
	objective: string;
	status: LocalBrowserRunStatus;
	pause_reason: string | null;
	error_code: string | null;
	error: string | null;
	policy: string;
	result: string | null;
	engine_auth: string | null;
	runner_node: string | null;
	runner_task_id: string | null;
	runner_seq: number;
	last_synced_at: number | null;
	created_at: number;
	started_at: number | null;
	ended_at: number | null;
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

const present = (r: RunRow): LocalBrowserRun => ({
	id: r.id,
	instanceId: r.instance_id,
	requestId: r.request_id,
	objective: r.objective,
	status: r.status,
	pauseReason: r.pause_reason,
	errorCode: r.error_code,
	error: r.error,
	policy: json<EffectiveLocalBrowserPolicy>(r.policy) as EffectiveLocalBrowserPolicy,
	result: json<LocalBrowserResultEnvelope>(r.result),
	engineAuth: r.engine_auth,
	runnerNode: r.runner_node,
	runnerTaskId: r.runner_task_id,
	runnerSeq: Number(r.runner_seq ?? 0),
	lastSyncedAt: r.last_synced_at ?? null,
	createdAt: r.created_at,
	startedAt: r.started_at,
	endedAt: r.ended_at,
	updatedAt: r.updated_at,
});

// Inlined, not bound: a closed set of constants (see `sqlLiteralList` for why that is the safe case).
const ACTIVE_SQL = sqlLiteralList(ACTIVE_RUN_STATUSES);

// ── Settings (agent_instances.config.localBrowser) ───────────────────────────────────────────

export async function readLocalBrowserSettings(env: DB, instanceId: string, userId: string): Promise<{ settings: unknown; runnerNode: string | null }> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, userId).first<{ config: string | null }>();
	const cfg = json<Record<string, unknown>>(row?.config ?? null) ?? {};
	return { settings: cfg.localBrowser ?? {}, runnerNode: typeof cfg.runnerNode === "string" && cfg.runnerNode ? cfg.runnerNode : null };
}

/** One json_set on one key, so a concurrent write to another config key is not lost. */
export async function writeLocalBrowserSettings(env: DB, instanceId: string, userId: string, settings: LocalBrowserSettings): Promise<void> {
	await env.DB.prepare(
		`UPDATE agent_instances
		    SET config = json_set(CASE WHEN config IS NULL OR config = '' OR NOT json_valid(config) THEN '{}' ELSE config END, '$.localBrowser', json(?1)),
		        updated_at = datetime('now')
		  WHERE id = ?2 AND user_id = ?3`,
	)
		.bind(JSON.stringify(settings), instanceId, userId)
		.run();
}

// ── Runs ─────────────────────────────────────────────────────────────────────────────────────

export async function getLocalBrowserRun(env: DB, instanceId: string, userId: string, runId: string): Promise<LocalBrowserRun | null> {
	const row = await env.DB.prepare("SELECT * FROM local_browser_runs WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3").bind(runId, instanceId, userId).first<RunRow>();
	return row ? present(row) : null;
}

export async function listLocalBrowserRuns(env: DB, instanceId: string, userId: string, limit: number): Promise<LocalBrowserRun[]> {
	const { results } = await env.DB.prepare("SELECT * FROM local_browser_runs WHERE instance_id = ?1 AND user_id = ?2 ORDER BY created_at DESC, id DESC LIMIT ?3")
		.bind(instanceId, userId, limit)
		.all<RunRow>();
	return (results ?? []).map(present);
}

export type ClaimRunOutcome = { kind: "created"; run: LocalBrowserRun } | { kind: "existing"; run: LocalBrowserRun } | { kind: "at_capacity"; active: number };

/**
 * Create a queued run — atomically against BOTH the idempotency key and the concurrency cap.
 * One INSERT … SELECT … WHERE (active) < cap ON CONFLICT DO NOTHING: two starts racing past a
 * read-then-write check would both see room, which is how a cap of 1 runs two engines.
 */
export async function claimLocalBrowserRun(
	env: DB,
	input: { id: string; instanceId: string; userId: string; requestId: string; objective: string; policy: EffectiveLocalBrowserPolicy; now: number },
): Promise<ClaimRunOutcome> {
	const res = await env.DB.prepare(
		`INSERT INTO local_browser_runs (id, instance_id, user_id, request_id, objective, status, policy, created_at, updated_at)
		 SELECT ?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?7, ?7
		  WHERE (SELECT COUNT(*) FROM local_browser_runs WHERE instance_id = ?2 AND user_id = ?3 AND status IN (${ACTIVE_SQL})) < ?8
		 ON CONFLICT(instance_id, request_id) DO NOTHING`,
	)
		.bind(input.id, input.instanceId, input.userId, input.requestId, input.objective, JSON.stringify(input.policy), input.now, input.policy.limits.maxConcurrent)
		.run();
	if ((res.meta?.changes ?? 0) > 0) return { kind: "created", run: (await getLocalBrowserRun(env, input.instanceId, input.userId, input.id)) as LocalBrowserRun };
	const existing = await env.DB.prepare("SELECT * FROM local_browser_runs WHERE instance_id = ?1 AND user_id = ?2 AND request_id = ?3")
		.bind(input.instanceId, input.userId, input.requestId)
		.first<RunRow>();
	if (existing) return { kind: "existing", run: present(existing) };
	const active = await env.DB.prepare(`SELECT COUNT(*) AS n FROM local_browser_runs WHERE instance_id = ?1 AND user_id = ?2 AND status IN (${ACTIVE_SQL})`)
		.bind(input.instanceId, input.userId)
		.first<{ n: number }>();
	return { kind: "at_capacity", active: Number(active?.n ?? 0) };
}

export interface RunTransition {
	to: LocalBrowserRunStatus;
	pauseReason?: string | null;
	errorCode?: string | null;
	error?: string | null;
	result?: LocalBrowserResultEnvelope | null;
	engineAuth?: string | null;
	runnerNode?: string | null;
	runnerTaskId?: string | null;
}

/**
 * Move a run, if the lifecycle allows it from the state it is in NOW. Compare-and-set on the
 * status read, so a cancel landing between the read and the write is not overwritten.
 * Returns the run after the move, or null when the move is not allowed (or lost the race).
 */
export async function transitionLocalBrowserRun(env: DB, instanceId: string, userId: string, runId: string, t: RunTransition, now: number): Promise<LocalBrowserRun | null> {
	const run = await getLocalBrowserRun(env, instanceId, userId, runId);
	if (!run || !canTransition(run.status, t.to)) return null;
	const terminal = t.to === "completed" || t.to === "failed" || t.to === "cancelled";
	const res = await env.DB.prepare(
		`UPDATE local_browser_runs
		    SET status = ?1,
		        pause_reason = ?2,
		        error_code = COALESCE(?3, error_code),
		        error = COALESCE(?4, error),
		        result = COALESCE(?5, result),
		        engine_auth = COALESCE(?6, engine_auth),
		        runner_node = COALESCE(?7, runner_node),
		        runner_task_id = COALESCE(?8, runner_task_id),
		        started_at = CASE WHEN ?1 = 'running' AND started_at IS NULL THEN ?9 ELSE started_at END,
		        ended_at = CASE WHEN ?10 THEN ?9 ELSE ended_at END,
		        updated_at = ?9
		  WHERE id = ?11 AND instance_id = ?12 AND user_id = ?13 AND status = ?14`,
	)
		.bind(
			t.to,
			t.to === "paused" ? (t.pauseReason ?? null) : null,
			t.errorCode ?? null,
			t.error ?? null,
			t.result ? JSON.stringify(t.result) : null,
			t.engineAuth ?? null,
			t.runnerNode ?? null,
			t.runnerTaskId ?? null,
			now,
			terminal ? 1 : 0,
			runId,
			instanceId,
			userId,
			run.status,
		)
		.run();
	if ((res.meta?.changes ?? 0) === 0) return null;
	return getLocalBrowserRun(env, instanceId, userId, runId);
}

// ── Events ───────────────────────────────────────────────────────────────────────────────────

/** Events kept per run. A runner that reports more is told so rather than growing the table without bound. */
export const MAX_EVENTS_PER_RUN = 2000;

/** A runner-reported event, or one PAGS recorded itself. */
export type TraceEvent = Omit<LocalBrowserEvent, "type"> & { type: LocalBrowserEvent["type"] | LocalBrowserPlatformEventType };

export interface StoredLocalBrowserEvent extends TraceEvent {
	seq: number;
	recordedAt: number;
}

/**
 * Append events after the run's current last seq. Returns how many were stored.
 *
 * `cursor` records how far into the RUNNER's trace these events reach, in the same atomic batch —
 * so a pull that stored its events also moved its cursor, and the next pull cannot store them twice.
 */
export async function appendLocalBrowserEvents(env: DB, instanceId: string, userId: string, runId: string, events: TraceEvent[], now: number, cursor?: { runnerSeq: number }): Promise<number> {
	const cursorStmt = cursor
		? env.DB.prepare("UPDATE local_browser_runs SET runner_seq = MAX(runner_seq, ?1), last_synced_at = ?2 WHERE id = ?3 AND instance_id = ?4 AND user_id = ?5").bind(cursor.runnerSeq, now, runId, instanceId, userId)
		: null;
	if (!events.length) {
		if (cursorStmt) await cursorStmt.run();
		return 0;
	}
	const last = await env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS seq, COUNT(*) AS n FROM local_browser_run_events WHERE run_id = ?1").bind(runId).first<{ seq: number; n: number }>();
	const room = Math.max(0, MAX_EVENTS_PER_RUN - Number(last?.n ?? 0));
	const take = events.slice(0, room);
	let seq = Number(last?.seq ?? 0);
	const stmts = take.map((e) =>
		env.DB.prepare(
			`INSERT INTO local_browser_run_events (run_id, seq, instance_id, user_id, type, url, domain, pause_reason, consent_id, detail, at, recorded_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
		).bind(runId, ++seq, instanceId, userId, e.type, e.url ?? null, e.domain ?? null, e.pauseReason ?? null, e.consentId ?? null, e.detail ? JSON.stringify(e.detail) : null, e.at, now),
	);
	if (cursorStmt) stmts.push(cursorStmt);
	if (stmts.length) await env.DB.batch(stmts);
	return take.length;
}

export async function listLocalBrowserEvents(env: DB, instanceId: string, userId: string, runId: string, afterSeq: number, limit: number): Promise<StoredLocalBrowserEvent[]> {
	const { results } = await env.DB.prepare(
		`SELECT seq, type, url, domain, pause_reason, consent_id, detail, at, recorded_at FROM local_browser_run_events
		  WHERE run_id = ?1 AND instance_id = ?2 AND user_id = ?3 AND seq > ?4 ORDER BY seq LIMIT ?5`,
	)
		.bind(runId, instanceId, userId, afterSeq, limit)
		.all<{ seq: number; type: TraceEvent["type"]; url: string | null; domain: string | null; pause_reason: string | null; consent_id: string | null; detail: string | null; at: string; recorded_at: number }>();
	return (results ?? []).map((r) => ({
		seq: r.seq,
		type: r.type,
		at: r.at,
		recordedAt: r.recorded_at,
		...(r.url ? { url: r.url } : {}),
		...(r.domain ? { domain: r.domain } : {}),
		...(r.pause_reason ? { pauseReason: r.pause_reason as LocalBrowserEvent["pauseReason"] } : {}),
		...(r.consent_id ? { consentId: r.consent_id } : {}),
		...(r.detail ? { detail: json<Record<string, unknown>>(r.detail) ?? undefined } : {}),
	}));
}

// ── Domain consent ───────────────────────────────────────────────────────────────────────────

export type ConsentScope = "navigate" | "signed_in_profile";
/** The `domain` value a signed-in-profile decision is stored under. */
export const PROFILE_CONSENT_DOMAIN = "*";

export interface DomainConsent {
	domain: string;
	scope: ConsentScope;
	decision: "allow" | "deny";
	decidedAt: number;
	expiresAt: number | null;
}

/** Live decisions — an expired one is as good as none, so it is not returned. */
export async function listDomainConsent(env: DB, instanceId: string, userId: string, now: number): Promise<DomainConsent[]> {
	const { results } = await env.DB.prepare(
		`SELECT domain, scope, decision, decided_at, expires_at FROM local_browser_domain_consent
		  WHERE instance_id = ?1 AND user_id = ?2 AND (expires_at IS NULL OR expires_at > ?3) ORDER BY scope, domain`,
	)
		.bind(instanceId, userId, now)
		.all<{ domain: string; scope: ConsentScope; decision: "allow" | "deny"; decided_at: number; expires_at: number | null }>();
	return (results ?? []).map((r) => ({ domain: r.domain, scope: r.scope, decision: r.decision, decidedAt: r.decided_at, expiresAt: r.expires_at }));
}

export async function setDomainConsent(env: DB, instanceId: string, userId: string, c: { domain: string; scope: ConsentScope; decision: "allow" | "deny" | null; expiresAt: number | null }, now: number): Promise<void> {
	if (c.decision === null) {
		await env.DB.prepare("DELETE FROM local_browser_domain_consent WHERE instance_id = ?1 AND user_id = ?2 AND domain = ?3 AND scope = ?4").bind(instanceId, userId, c.domain, c.scope).run();
		return;
	}
	await env.DB.prepare(
		`INSERT INTO local_browser_domain_consent (instance_id, user_id, domain, scope, decision, decided_at, expires_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
		 ON CONFLICT(instance_id, domain, scope) DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at, expires_at = excluded.expires_at`,
	)
		.bind(instanceId, userId, c.domain, c.scope, c.decision, now, c.expiresAt)
		.run();
}

// ── The pull (#944) ──────────────────────────────────────────────────────────────────────────

/** Active runs, least recently synced first — what the cron reads from the runners. */
export async function activeLocalBrowserRuns(env: DB, limit: number): Promise<Array<{ id: string; instanceId: string; userId: string }>> {
	const { results } = await env.DB.prepare(`SELECT id, instance_id, user_id FROM local_browser_runs WHERE status IN (${ACTIVE_SQL}) ORDER BY COALESCE(last_synced_at, 0) LIMIT ?1`)
		.bind(limit)
		.all<{ id: string; instance_id: string; user_id: string }>();
	return (results ?? []).map((r) => ({ id: r.id, instanceId: r.instance_id, userId: r.user_id }));
}

/**
 * Delete the trace of runs that ended longer ago than their own `traceRetentionDays` (the policy the
 * run started with). The run row and its result stay; only the step-by-step trace goes.
 */
export async function pruneExpiredLocalBrowserTraces(env: DB, now: number): Promise<number> {
	const res = await env.DB.prepare(
		`DELETE FROM local_browser_run_events WHERE run_id IN (
		   SELECT id FROM local_browser_runs
		    WHERE ended_at IS NOT NULL AND ended_at < ?1 - COALESCE(json_extract(policy, '$.traceRetentionDays'), 30) * 86400000)`,
	)
		.bind(now)
		.run();
	return res.meta?.changes ?? 0;
}
