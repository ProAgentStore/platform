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
import { normalizeRunnerNode } from "./runtime-nodes.js";

export type RepoOwner =
	| { kind: "run"; sessionId: string | null; runId: string; since: number }
	| { kind: "driver"; sessionId: string; since: number | null }
	| { kind: "direct"; sessionId: string; turnId: string; since: number; deliveredAt: number | null };

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
		`SELECT id, driver_id, driver_at, direct_turn_id, direct_turn_at, direct_turn_delivered_at FROM coding_sessions
		  WHERE instance_id = ?1 AND user_id = ?2 AND repo_id = ?3 AND (driver_id IS NOT NULL OR direct_turn_id IS NOT NULL)`,
	)
		.bind(scope.instanceId, scope.userId, scope.repoId)
		.all<{ id: string; driver_id: string | null; driver_at: string | number | null; direct_turn_id: string | null; direct_turn_at: number | null; direct_turn_delivered_at: number | null }>();
	const owners: RepoOwner[] = (runs.results ?? []).map((r) => ({ kind: "run", sessionId: r.session_id, runId: r.run_id, since: r.started_at }));
	for (const s of sessions.results ?? []) {
		if (s.driver_id) owners.push({ kind: "driver", sessionId: s.id, since: typeof s.driver_at === "number" ? s.driver_at : s.driver_at ? Date.parse(`${String(s.driver_at).replace(" ", "T")}Z`) : null });
		if (s.direct_turn_id) owners.push({ kind: "direct", sessionId: s.id, turnId: s.direct_turn_id, since: s.direct_turn_at ?? 0, deliveredAt: s.direct_turn_delivered_at ?? null });
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
 * How long a reservation that never recorded a delivery is held through an idle engine (#1015).
 *
 * Between a claim and its send the engine is idle BECAUSE the message has not arrived yet, so an idle
 * probe there is not evidence the turn finished — releasing on it let a successor in ahead of the very
 * instruction the claim was taken for. Past this bound the dispatcher that took it is gone (a Worker
 * outlives no request this long), and an idle engine means nothing is writing.
 */
export const RESERVATION_STALE_MS = 10 * 60_000;

/**
 * Release every direct claim on this repo whose engine the runner confirms idle or stopped, and
 * return the owners that remain. `busy` and `unknown` keep their claim. The clear is keyed to the
 * claim it read, so a turn admitted after the probe is never released by it.
 *
 * Two claims are kept even when the engine is idle (#1015): one whose message has not been
 * delivered yet (unless stale), and — when `own` names a watcher's turn — a NEWER claim on that
 * watcher's session, which belongs to a later send and its own watcher, not to this one.
 */
export async function settleDirectTurns(env: Env, scope: Scope, probe: ProbeEngine, own?: { sessionId: string; turnId: string }, now: number = Date.now()): Promise<RepoOwner[]> {
	const owners = await repoOwners(env, scope);
	const remaining: RepoOwner[] = [];
	for (const o of owners) {
		if (o.kind !== "direct") {
			remaining.push(o);
			continue;
		}
		const newerThanWatcher = own && o.sessionId === own.sessionId && o.turnId !== own.turnId;
		const undelivered = o.deliveredAt === null && now - o.since < RESERVATION_STALE_MS;
		if (newerThanWatcher || undelivered) {
			remaining.push(o);
			continue;
		}
		const state = await probe(o.sessionId).catch((): EngineProbe => "unknown");
		if (state === "idle" || state === "stopped") {
			await releaseReservation(env, o.sessionId, o.turnId);
		} else remaining.push(o);
	}
	return remaining;
}

/**
 * Clear one reservation — only that one: a claim taken since by another send is left alone.
 * True when THIS call cleared it, so of two settlers racing for one claim exactly one acts on it.
 */
export async function releaseReservation(env: Env, sessionId: string, turnId: string): Promise<boolean> {
	const res = await env.DB.prepare("UPDATE coding_sessions SET direct_turn_id = NULL, direct_turn_at = NULL, direct_turn_delivered_at = NULL WHERE id = ?1 AND direct_turn_id = ?2")
		.bind(sessionId, turnId)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

export type DirectAdmission =
	/** The session's own run drives it: the message STEERS that run, and the run stays the owner. */
	| { ok: true; kind: "steer"; runId: string | null; turnId: string }
	/** This session now holds the checkout for a direct turn. */
	| { ok: true; kind: "direct"; turnId: string }
	| { ok: false; owner: RepoOwner };

/**
 * Admit one direct turn on `sessionId`, or name who holds the checkout instead.
 *
 * The claim is ONE conditional UPDATE that repeats every foreign-owner predicate, so two concurrent
 * admissions — two direct turns on different sessions, or a direct turn racing a run start — cannot
 * both win. Successive turns on the SAME session replace its own claim.
 *
 * A STEER reserves too (#1015). It used to claim nothing and lean on its run staying the owner — but
 * the run can end between this read and the send, and a queued successor admitted in that gap then
 * shared the checkout with an instruction still on its way. The reservation is what a successor's
 * admission sees, so the gap is closed in the database rather than raced in the route.
 */
export async function admitDirectTurn(env: Env, scope: Scope & { sessionId: string }, probe: ProbeEngine, now: number = Date.now()): Promise<DirectAdmission> {
	const owners = await settleDirectTurns(env, scope, probe, undefined, now);
	const foreign = owners.find((o) => o.sessionId !== scope.sessionId);
	if (foreign) return { ok: false, owner: foreign };

	const turnId = `dturn-${crypto.randomUUID()}`;
	const res = await env.DB.prepare(
		`UPDATE coding_sessions SET direct_turn_id = ?5, direct_turn_at = ?6, direct_turn_delivered_at = NULL
		  WHERE id = ?4 AND instance_id = ?1 AND user_id = ?2 AND repo_id = ?3
		    AND NOT EXISTS (SELECT 1 FROM coding_sessions o WHERE o.instance_id = ?1 AND o.repo_id = ?3 AND o.id <> ?4 AND (o.driver_id IS NOT NULL OR o.direct_turn_id IS NOT NULL))
		    AND NOT EXISTS (SELECT 1 FROM agent_loop_runs r JOIN coding_sessions rs ON rs.id = r.session_id WHERE r.instance_id = ?1 AND rs.repo_id = ?3 AND rs.id <> ?4 AND r.status = 'running')`,
	)
		.bind(scope.instanceId, scope.userId, scope.repoId, scope.sessionId, turnId, now)
		.run();
	const after = await repoOwners(env, scope);
	if ((res.meta?.changes ?? 0) > 0) {
		// This session's own run or driver claim makes it a steer of that run; otherwise a direct turn.
		const own = after.find((o) => o.sessionId === scope.sessionId && (o.kind === "run" || o.kind === "driver"));
		return own ? { ok: true, kind: "steer", runId: own.kind === "run" ? own.runId : null, turnId } : { ok: true, kind: "direct", turnId };
	}
	// Lost a race: name the winner.
	const winner = after.find((o) => o.sessionId !== scope.sessionId);
	return { ok: false, owner: winner ?? { kind: "direct", sessionId: scope.sessionId, turnId: "unknown", since: now, deliveredAt: null } };
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

/**
 * The production probe: ask the machine that session is stamped to. No machine is `unknown`.
 *
 * A capture that fails is `unknown` — with one exception: the session's OWN stamped machine
 * answering that it has no session by this exact id. That is the runner's word that no engine of
 * this session runs there (`/coding/end` removes it from the runner's map), and reading it as
 * `unknown` kept a steer's claim on an ended session forever (#1015). A timeout, a disconnect, a
 * malformed reply, another id, or an unstamped session answered by whichever machine is default
 * proves nothing, and stays `unknown`.
 */
export function runnerEngineProbe(env: Env, instanceId: string, userId: string): ProbeEngine {
	return async (sessionId) => {
		const row = await env.DB.prepare("SELECT runner_node FROM coding_sessions WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
			.bind(sessionId, instanceId, userId)
			.first<{ runner_node: string | null }>();
		const conn = await getRunnerConn(env, instanceId, userId, row?.runner_node ?? null).catch(() => null);
		if (!conn) return "unknown";
		const stamped = normalizeRunnerNode(row?.runner_node);
		const onStampedMachine = stamped !== "" && normalizeRunnerNode(conn.runnerNode) === stamped;
		let absent = false;
		const snap = await callRunner<{ alive?: boolean; ready?: boolean }>(conn, "/coding/capture", { sessionId }, { timeoutMs: READ_TIMEOUT_MS }).catch((e: unknown) => {
			absent = onStampedMachine && captureSaysSessionAbsent(e, sessionId);
			return null;
		});
		return absent ? "stopped" : engineProbeFromSnapshot(snap);
	};
}

/**
 * Did `/coding/capture` fail because the runner has no session with exactly this id? The runner
 * answers a missing session with 500 `{"error":"No coding session: <id>"}`, which `callRunner`
 * raises as `Runner /coding/capture → 500: <body>`. Anything else is not that answer.
 */
export function captureSaysSessionAbsent(e: unknown, sessionId: string): boolean {
	const msg = e instanceof Error ? e.message : "";
	const prefix = "Runner /coding/capture → 500: ";
	if (!msg.startsWith(prefix)) return false;
	try {
		const body = JSON.parse(msg.slice(prefix.length)) as { error?: unknown };
		return body?.error === `No coding session: ${sessionId}`;
	} catch {
		return false;
	}
}

/** A runner snapshot, reduced. No snapshot is `unknown`, never `idle`. */
export function engineProbeFromSnapshot(snap: { alive?: boolean; ready?: boolean } | null | undefined): EngineProbe {
	if (!snap || typeof snap.alive !== "boolean") return "unknown";
	if (!snap.alive) return "stopped";
	return snap.ready === true ? "idle" : "busy";
}

/** What is known about how a message met the engine (#1015), and `accepted` when nothing is (#1019). */
export type DirectiveDelivery = "accepted" | "delivered" | "queued" | "interrupting";

/**
 * How a message reaches an engine, from what it was doing when the message was sent.
 *
 * `unknown` is `accepted`, never `delivered` (#1019): the runner took the message, but nobody saw
 * whether an idle engine read it — and "delivered" was a claim that it had, made on no evidence.
 */
export function deliveryFor(probe: EngineProbe, persistent: boolean): DirectiveDelivery {
	if (probe === "unknown") return "accepted";
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
	delivery: DirectiveDelivery;
	content: string;
	createdAt: number;
	processedAt: number | null;
}

export async function recordDirective(
	env: Env,
	input: Scope & { sessionId: string; runId: string | null; kind: Directive["kind"]; delivery: Directive["delivery"]; content: string; now?: number; id?: string },
): Promise<Directive> {
	const d: Directive = {
		// The dispatcher mints the id BEFORE the send so it rides to the runner as the input's id (#1019).
		id: input.id ?? newDirectiveId(),
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

/**
 * A session's directives since `sinceMs`, oldest first — what the Pilot reloads every decision.
 *
 * The default bound is the NEWEST ten, which is right for display and wrong for constraints: a
 * "read-only" sent early in a run must still bind after ten more messages (#1019). The Pilot's
 * reload asks for {@link RUN_DIRECTIVES_MAX} and says when even that was not all of them.
 */
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

/** A directive id, minted before the send so the runner can report the turn that consumed it (#1019). */
export function newDirectiveId(): string {
	return `dir-${crypto.randomUUID()}`;
}

/** The most directives one Pilot reload reads — every one a run has had, in any real run (#1019). */
export const RUN_DIRECTIVES_MAX = 500;

/**
 * Mark directives the engine has demonstrably processed: the ids the RUNNER reports a completed turn
 * consumed (`consumedInputs`, #1019), and nothing else.
 *
 * Time cannot say it. This used to mark every directive recorded before the last turn's end — but a
 * directive QUEUED while turn A runs is recorded before A ends without A ever reading it, so the
 * owner was told a correction had been acted on while it sat unread behind A. The runner correlates
 * a turn with the input it answered (`HeadlessSession.consumedInputs`); the cloud only records it.
 * A runner that predates the field reports nothing, and its directives stay accepted / delivered /
 * queued — "not yet confirmed" — rather than being credited on a clock.
 */
export async function markDirectivesProcessed(
	env: Env,
	input: { instanceId: string; userId: string; sessionId: string; consumed: readonly string[] | null | undefined; now?: number },
): Promise<number> {
	const ids = [...new Set(input.consumed ?? [])].filter((id) => typeof id === "string" && id.startsWith("dir-")).slice(-100);
	if (!ids.length) return 0;
	const res = await env.DB.prepare(
		`UPDATE coding_session_directives SET processed_at = ?4
		  WHERE session_id = ?1 AND instance_id = ?2 AND user_id = ?3 AND processed_at IS NULL
		    AND id IN (SELECT value FROM json_each(?5))`,
	)
		.bind(input.sessionId, input.instanceId, input.userId, input.now ?? Date.now(), JSON.stringify(ids))
		.run();
	return res.meta?.changes ?? 0;
}
