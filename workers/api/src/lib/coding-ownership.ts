/**
 * One writer per repository checkout, whichever way an engine is driven (#1015).
 *
 * A run claims its session with `driver_id` (#208) and a new run is admitted only past #984's
 * handover check. A DIRECT turn — `coding_session_message`, the console's send box — claimed nothing.
 * Sent to a retained session whose run had ended, it reactivated that engine in the shared checkout
 * while another run worked it, and a later queue drain admitted a third writer, because the direct
 * turn left no trace any admission check could read. Its run was correctly `ended`; its ENGINE was
 * not, and "the run ended" was being read as "the checkout is free".
 *
 * So ownership is read from three places, per REPO (sessions of one repo share one checkout, and the
 * incident's two sessions were different rows):
 *
 *   - `run`    — an `agent_loop_runs` row still `running` on a session of this repo;
 *   - `driver` — a session of this repo whose single-flight claim is held;
 *   - `direct` — a session of this repo with an admitted direct turn (`direct_turn_id`, 0211).
 *
 * A direct claim is RELEASED only on the runner's word that the engine is idle or gone. A machine
 * that cannot be asked keeps the claim: unknown fails closed, and a queued objective waits (it is
 * requeued, never failed) until the watcher that follows the turn sees it finish.
 */
import type { Env } from "../types.js";
import { clipMarked } from "./clip-marked.js";
import { callRunner, getRunnerConn, READ_TIMEOUT_MS } from "./runner-client.js";

export type RepoOwner =
	| { kind: "run"; sessionId: string | null; runId: string; since: number }
	| { kind: "driver"; sessionId: string; since: number | null }
	| { kind: "direct"; sessionId: string; turnId: string; since: number };

/** What the runner says about one session's engine, reduced to what ownership needs. */
export type EngineProbe = "idle" | "busy" | "stopped" | "unknown";
export type ProbeEngine = (sessionId: string) => Promise<EngineProbe>;

interface Scope {
	instanceId: string;
	userId: string;
	repoId: string;
}

/** Every current owner of this repo's checkout, oldest first. Reads only. */
export async function repoOwners(env: Env, scope: Scope): Promise<RepoOwner[]> {
	const runs = await env.DB.prepare(
		`SELECT r.run_id, r.session_id, r.started_at FROM agent_loop_runs r
		   JOIN coding_sessions s ON s.id = r.session_id
		  WHERE r.instance_id = ?1 AND r.user_id = ?2 AND s.repo_id = ?3 AND r.status = 'running'`,
	)
		.bind(scope.instanceId, scope.userId, scope.repoId)
		.all<{ run_id: string; session_id: string | null; started_at: number }>();
	const sessions = await env.DB.prepare(
		`SELECT id, driver_id, driver_at, direct_turn_id, direct_turn_at FROM coding_sessions
		  WHERE instance_id = ?1 AND user_id = ?2 AND repo_id = ?3 AND (driver_id IS NOT NULL OR direct_turn_id IS NOT NULL)`,
	)
		.bind(scope.instanceId, scope.userId, scope.repoId)
		.all<{ id: string; driver_id: string | null; driver_at: string | number | null; direct_turn_id: string | null; direct_turn_at: number | null }>();
	const owners: RepoOwner[] = (runs.results ?? []).map((r) => ({ kind: "run", sessionId: r.session_id, runId: r.run_id, since: r.started_at }));
	for (const s of sessions.results ?? []) {
		if (s.driver_id) owners.push({ kind: "driver", sessionId: s.id, since: typeof s.driver_at === "number" ? s.driver_at : s.driver_at ? Date.parse(`${String(s.driver_at).replace(" ", "T")}Z`) : null });
		if (s.direct_turn_id) owners.push({ kind: "direct", sessionId: s.id, turnId: s.direct_turn_id, since: s.direct_turn_at ?? 0 });
	}
	return owners.sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
}

/** One sentence naming who holds the checkout, for a refusal or a queue entry's waiting reason. */
export function describeOwner(owner: RepoOwner, repoName: string): string {
	if (owner.kind === "direct") {
		return `${repoName} is held by a direct engine turn on session ${owner.sessionId} (since ${new Date(owner.since).toISOString()}). It is released when that engine is confirmed idle.`;
	}
	if (owner.kind === "run") return `${repoName} is being worked by run ${owner.runId}${owner.sessionId ? ` on session ${owner.sessionId}` : ""}.`;
	return `${repoName} is being driven on session ${owner.sessionId}.`;
}

/**
 * Release every direct claim on this repo whose engine the runner confirms idle or stopped, and
 * return the owners that remain. `busy` and `unknown` keep their claim. The clear is keyed to the
 * claim it read, so a turn admitted after the probe is never released by it.
 */
export async function settleDirectTurns(env: Env, scope: Scope, probe: ProbeEngine): Promise<RepoOwner[]> {
	const owners = await repoOwners(env, scope);
	const remaining: RepoOwner[] = [];
	for (const o of owners) {
		if (o.kind !== "direct") {
			remaining.push(o);
			continue;
		}
		const state = await probe(o.sessionId).catch((): EngineProbe => "unknown");
		if (state === "idle" || state === "stopped") {
			await env.DB.prepare("UPDATE coding_sessions SET direct_turn_id = NULL, direct_turn_at = NULL WHERE id = ?1 AND direct_turn_id = ?2")
				.bind(o.sessionId, o.turnId)
				.run();
		} else remaining.push(o);
	}
	return remaining;
}

export type DirectAdmission =
	/** The session's own run drives it: the message STEERS that run, and the run stays the owner. */
	| { ok: true; kind: "steer"; runId: string | null }
	/** This session now holds the checkout for a direct turn. */
	| { ok: true; kind: "direct"; turnId: string }
	| { ok: false; owner: RepoOwner };

/**
 * Admit one direct turn on `sessionId`, or name who holds the checkout instead.
 *
 * The claim is ONE conditional UPDATE that repeats every foreign-owner predicate, so two concurrent
 * admissions — two direct turns on different sessions, or a direct turn racing a run start — cannot
 * both win. Successive direct turns on the SAME session replace its own claim.
 */
export async function admitDirectTurn(env: Env, scope: Scope & { sessionId: string }, probe: ProbeEngine, now: number = Date.now()): Promise<DirectAdmission> {
	const owners = await settleDirectTurns(env, scope, probe);
	const foreign = owners.find((o) => o.sessionId !== scope.sessionId);
	if (foreign) return { ok: false, owner: foreign };
	const own = owners.find((o) => o.kind === "run" || o.kind === "driver");
	if (own) return { ok: true, kind: "steer", runId: own.kind === "run" ? own.runId : null };

	const turnId = `dturn-${crypto.randomUUID()}`;
	const res = await env.DB.prepare(
		`UPDATE coding_sessions SET direct_turn_id = ?5, direct_turn_at = ?6
		  WHERE id = ?4 AND instance_id = ?1 AND user_id = ?2 AND repo_id = ?3 AND driver_id IS NULL
		    AND NOT EXISTS (SELECT 1 FROM coding_sessions o WHERE o.instance_id = ?1 AND o.repo_id = ?3 AND o.id <> ?4 AND (o.driver_id IS NOT NULL OR o.direct_turn_id IS NOT NULL))
		    AND NOT EXISTS (SELECT 1 FROM agent_loop_runs r JOIN coding_sessions rs ON rs.id = r.session_id WHERE r.instance_id = ?1 AND rs.repo_id = ?3 AND r.status = 'running')`,
	)
		.bind(scope.instanceId, scope.userId, scope.repoId, scope.sessionId, turnId, now)
		.run();
	if ((res.meta?.changes ?? 0) > 0) return { ok: true, kind: "direct", turnId };
	// Lost a race: re-read and name the winner. A winner that is this session's own run is a steer.
	const after = await repoOwners(env, scope);
	const winner = after.find((o) => o.sessionId !== scope.sessionId) ?? after.find((o) => o.kind === "run" || o.kind === "driver");
	if (winner && winner.sessionId === scope.sessionId && winner.kind !== "direct") return { ok: true, kind: "steer", runId: winner.kind === "run" ? winner.runId : null };
	return winner ? { ok: false, owner: winner } : { ok: false, owner: { kind: "direct", sessionId: scope.sessionId, turnId: "unknown", since: now } };
}

/**
 * Whether a NEW run may take this repo: release confirmed-idle direct claims first, then refuse
 * while any direct turn, or a run/driver on ANOTHER session, still holds the checkout. A run or
 * driver on the session the start is about to use is left to `claimSessionDriver`, which already
 * answers that case.
 */
export async function repoFreeForRun(env: Env, scope: Scope & { sessionId?: string | null }, probe: ProbeEngine): Promise<{ free: true } | { free: false; owner: RepoOwner }> {
	const owners = await settleDirectTurns(env, scope, probe);
	const blocking = owners.find((o) => o.kind === "direct" || (scope.sessionId != null && o.sessionId !== scope.sessionId));
	return blocking ? { free: false, owner: blocking } : { free: true };
}

/** The production probe: ask the machine that session is stamped to. No machine is `unknown`. */
export function runnerEngineProbe(env: Env, instanceId: string, userId: string): ProbeEngine {
	return async (sessionId) => {
		const row = await env.DB.prepare("SELECT runner_node FROM coding_sessions WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
			.bind(sessionId, instanceId, userId)
			.first<{ runner_node: string | null }>();
		const conn = await getRunnerConn(env, instanceId, userId, row?.runner_node ?? null).catch(() => null);
		if (!conn) return "unknown";
		const snap = await callRunner<{ alive?: boolean; ready?: boolean }>(conn, "/coding/capture", { sessionId }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null);
		return engineProbeFromSnapshot(snap);
	};
}

/** A runner snapshot, reduced. No snapshot is `unknown`, never `idle`. */
export function engineProbeFromSnapshot(snap: { alive?: boolean; ready?: boolean } | null | undefined): EngineProbe {
	if (!snap || typeof snap.alive !== "boolean") return "unknown";
	if (!snap.alive) return "stopped";
	return snap.ready === true ? "idle" : "busy";
}

/** How a message reaches an engine, from what it was doing when the message was sent. */
export function deliveryFor(probe: EngineProbe, persistent: boolean): "delivered" | "queued" | "interrupting" {
	if (probe !== "busy") return "delivered";
	// A persistent stream-json engine (Claude) reads stdin after its current turn; a one-shot engine
	// has that turn's process killed (`headless.ts` "turn aborted — a new instruction arrived").
	return persistent ? "queued" : "interrupting";
}

export interface Directive {
	id: string;
	sessionId: string;
	runId: string | null;
	kind: "direct" | "steer";
	delivery: "delivered" | "queued" | "interrupting";
	content: string;
	createdAt: number;
	processedAt: number | null;
}

export async function recordDirective(
	env: Env,
	input: Scope & { sessionId: string; runId: string | null; kind: Directive["kind"]; delivery: Directive["delivery"]; content: string; now?: number },
): Promise<Directive> {
	const d: Directive = {
		id: `dir-${crypto.randomUUID()}`,
		sessionId: input.sessionId,
		runId: input.runId,
		kind: input.kind,
		delivery: input.delivery,
		content: clipMarked(input.content, 4000),
		createdAt: input.now ?? Date.now(),
		processedAt: null,
	};
	await env.DB.prepare(
		`INSERT INTO coding_session_directives (id, session_id, instance_id, user_id, repo_id, run_id, kind, delivery, content, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
	)
		.bind(d.id, d.sessionId, input.instanceId, input.userId, input.repoId, d.runId, d.kind, d.delivery, d.content, d.createdAt)
		.run();
	return d;
}

/** A session's directives since `sinceMs`, oldest first — what the Pilot reloads every decision. */
export async function listDirectives(env: Env, input: { instanceId: string; userId: string; sessionId: string; sinceMs: number; limit?: number }): Promise<Directive[]> {
	const rows = await env.DB.prepare(
		`SELECT id, session_id, run_id, kind, delivery, content, created_at, processed_at FROM coding_session_directives
		  WHERE session_id = ?1 AND instance_id = ?2 AND user_id = ?3 AND created_at >= ?4
		  ORDER BY created_at DESC, rowid DESC LIMIT ?5`,
	)
		.bind(input.sessionId, input.instanceId, input.userId, input.sinceMs, input.limit ?? 10)
		.all<{ id: string; session_id: string; run_id: string | null; kind: Directive["kind"]; delivery: Directive["delivery"]; content: string; created_at: number; processed_at: number | null }>();
	return (rows.results ?? [])
		.map((r) => ({ id: r.id, sessionId: r.session_id, runId: r.run_id, kind: r.kind, delivery: r.delivery, content: r.content, createdAt: r.created_at, processedAt: r.processed_at }))
		.reverse();
}

/**
 * Mark directives the engine has demonstrably processed: it completed a turn that ended after the
 * directive was delivered. `turnEndedAt` is the runner's `lastTurn.at` (the machine's clock), so a
 * small skew allowance applies; no completed turn means nothing is marked.
 */
export async function markDirectivesProcessed(env: Env, input: { instanceId: string; userId: string; sessionId: string; turnEndedAt: number | null | undefined; skewMs?: number }): Promise<number> {
	if (!input.turnEndedAt) return 0;
	const res = await env.DB.prepare(
		`UPDATE coding_session_directives SET processed_at = ?4
		  WHERE session_id = ?1 AND instance_id = ?2 AND user_id = ?3 AND processed_at IS NULL AND created_at <= ?4 + ?5`,
	)
		.bind(input.sessionId, input.instanceId, input.userId, input.turnEndedAt, input.skewMs ?? 5_000)
		.run();
	return res.meta?.changes ?? 0;
}
