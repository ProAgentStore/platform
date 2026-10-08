/**
 * The claim, the probe and the persistence behind {@link handoffVerdict} (#984).
 *
 * `coding-handoff.ts` decides; this module is the only thing that reads a machine or writes a row.
 * Three jobs, and the split matters because the first two have different authority:
 *
 *   RAISE    when the PLATFORM closes a run that was holding a coding session — the sweeper, a
 *            cancel it had to land itself — the run's outcome is unaccounted for: nothing confirmed
 *            its engine stopped and nothing looked at its checkout. That fact is written onto the
 *            session, naming the run, its issue and its objective.
 *   RESOLVE  at the one door a coding run starts through, ask the machine what is actually true now
 *            and decide. Always re-probed: the stored state is a cache for listings, never the
 *            authority.
 *   RELEASE  a confirmed-clean handover clears the claim. Nothing else does, and nothing clears the
 *            WORK — see the policy note in `coding-handoff.ts`.
 *
 * Two kinds of owner can hold a checkout, and both are checked, because only the first was ever
 * visible in `agent_loop_runs`:
 *
 *   a CLOSED run with a claim        the sweeper got there (the #984 incident).
 *   a RUNNING run with a dead        nobody got there yet. Its session claim is already stealable
 *   heartbeat                        (`STALE_DRIVER_MS`), so `claimSessionDriver` would hand its
 *                                    live engine to the next objective — the same harm, 2h45m
 *                                    earlier, which is the window `coding-store.ts` documents.
 */
import { upsertWorkCard, closeWorkCards } from "./work-card.js";
import { cardDetail } from "./card-detail.js";
import { clipMarked } from "./clip-marked.js";
import { STALE_DRIVER_MS } from "./coding-store.js";
import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS, type RunnerConn } from "./runner-client.js";
import { readRepoWorkingState } from "./repo-state.js";
import {
	type EngineLiveness,
	type HandoffProbe,
	type HandoffVerdict,
	type IncomingWork,
	type RecoveryClaim,
	type RecoveryReason,
	handoffVerdict,
} from "./coding-handoff.js";
import type { CodingRepo } from "./coding-types.js";
import type { Env } from "../types.js";

/** How much of the owning objective is kept, so a human can tell whose work is in the tree. */
export const CLAIM_OBJECTIVE_CHARS = 400;

/**
 * How much of a handover sentence is stored for a listing to relay.
 *
 * `clipMarked`, not `slice`, on this and on the objective above (#898): both are read as whole
 * sentences — one by a person deciding what to recover, one by whatever reports why a queue is not
 * moving — and a cut that does not say it was cut reads as the complete reason.
 */
export const HANDOFF_DETAIL_CHARS = 1000;

/** Stable per-session card id for the recovery card. */
export const recoveryCardId = (sessionId: string): string => `crec-${sessionId}`;

/**
 * Record that a run stopped owning its session without accounting for what it left.
 *
 * An OPEN claim is never overwritten: the FIRST claim wins, because a session swept twice (a cancel
 * landed, then the staleness pass) must keep naming the run whose work is actually in the tree
 * rather than whichever pass ran last. A RELEASED one is replaceable — the session was handed over
 * cleanly and has since been worked in again, so the next interruption is a new owner.
 *
 * Best-effort by contract — it is called from the sweeper's close path, where a failed bookkeeping
 * write must not abort closing the run rows.
 */
export async function raiseRecoveryClaim(
	env: Env,
	input: { instanceId: string; userId: string; sessionId: string; runId: string; reason: RecoveryReason; objective: string; now?: number },
): Promise<void> {
	await env.DB.prepare(
		`UPDATE coding_sessions
		    SET recovery_run_id = ?4, recovery_reason = ?5, recovery_issue = issue_number,
		        recovery_objective = ?6, recovery_at = ?7, recovery_state = NULL, recovery_detail = NULL,
		        recovered_by_run_id = NULL, recovery_released_at = NULL
		  WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3
		    AND (recovery_run_id IS NULL OR recovery_released_at IS NOT NULL)`,
	)
		.bind(input.sessionId, input.instanceId, input.userId, input.runId, input.reason, clipMarked(input.objective, CLAIM_OBJECTIVE_CHARS), input.now ?? Date.now())
		.run()
		.catch(() => undefined);
}

interface ClaimRow {
	session_id: string;
	session_status: string;
	run_id: string;
	issue: number | null;
	objective: string | null;
	reason: string | null;
	at: number | null;
}

const toClaim = (r: ClaimRow, fallbackReason: RecoveryReason): RecoveryClaim => ({
	sessionId: r.session_id,
	runId: r.run_id,
	issue: typeof r.issue === "number" ? r.issue : null,
	objective: r.objective ?? "",
	reason: (r.reason as RecoveryReason) || fallbackReason,
	at: r.at ?? 0,
});

/** The claim a platform-closed run left on this repo, newest first. Null when there is none. */
export async function getRecoveryClaim(env: Env, instanceId: string, userId: string, repoId: string): Promise<RecoveryClaim | null> {
	const row = await env.DB.prepare(
		`SELECT id AS session_id, status AS session_status, recovery_run_id AS run_id, recovery_issue AS issue,
		        recovery_objective AS objective, recovery_reason AS reason, recovery_at AS at
		   FROM coding_sessions
		  WHERE repo_id = ?1 AND instance_id = ?2 AND user_id = ?3
		    AND recovery_run_id IS NOT NULL AND recovery_released_at IS NULL
		  ORDER BY recovery_at DESC LIMIT 1`,
	)
		.bind(repoId, instanceId, userId)
		.first<ClaimRow>()
		.catch(() => null);
	return row?.run_id ? toClaim(row, "interrupted") : null;
}

/**
 * A run still calling itself `running` on this repo whose orchestrator heartbeat is gone.
 *
 * The predicate is `claimSessionDriver`'s own takeable condition, deliberately: this returns exactly
 * the runs whose session the next start WOULD steal. A healthy long run heartbeats its claim on
 * every action (`touchSessionDriver`), so a stale `driver_at` is not "it has been a while" — it is
 * "nothing has been home for fifteen minutes".
 */
export async function getHeartbeatLostClaim(env: Env, instanceId: string, userId: string, repoId: string, now = Date.now()): Promise<RecoveryClaim | null> {
	const row = await env.DB.prepare(
		`SELECT s.id AS session_id, s.status AS session_status, r.run_id AS run_id, s.issue_number AS issue,
		        r.objective AS objective, 'heartbeat_lost' AS reason, r.started_at AS at
		   FROM agent_loop_runs r
		   JOIN coding_sessions s ON s.id = r.session_id
		  WHERE r.instance_id = ?1 AND r.user_id = ?2 AND r.status = 'running'
		    AND s.repo_id = ?3 AND s.status = 'active'
		    AND (s.driver_at IS NULL OR s.driver_at < ?4)
		  ORDER BY r.started_at DESC LIMIT 1`,
	)
		.bind(instanceId, userId, repoId, now - STALE_DRIVER_MS)
		.first<ClaimRow>()
		.catch(() => null);
	return row?.run_id ? toClaim(row, "heartbeat_lost") : null;
}

/** An engine the runner has no session for is CONFIRMED gone — the machine restarted, it died with it. */
function livenessFromError(message: string): EngineLiveness {
	return /no coding session/i.test(message) ? "terminal" : "unknown";
}

/**
 * Is the engine still there, and what is in the tree?
 *
 * Both reads are read-only (`/coding/capture` is a snapshot, `/coding/git` runs `status --short`
 * through the whitelisted argv), and nothing here writes to the repository — the refusal this feeds
 * exists precisely so that nobody's uncommitted work is touched.
 *
 * An ENDED session is terminal without a probe: `endSession` stops the engine, so there is no
 * process to ask about and asking would answer `No coding session` anyway.
 */
export async function probeHandoff(
	env: Env,
	input: { instanceId: string; userId: string; repo: CodingRepo; claim: RecoveryClaim; conn?: RunnerConn | null },
): Promise<HandoffProbe> {
	const conn = input.conn ?? (await getBoundRunnerConn(env, input.instanceId, input.userId).catch(() => null));
	// No machine to ask: `unknown`, which blocks. The coding driver has already refused a start with
	// no runner, so reaching here with none means the connection went away mid-admission.
	if (!conn) return { engine: "unknown", changedFiles: null };

	const snap = await callRunner<{ alive?: boolean }>(conn, "/coding/capture", { sessionId: input.claim.sessionId }, { timeoutMs: READ_TIMEOUT_MS })
		.then((s) => ({ ok: true as const, s }))
		.catch((e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) }));
	const engine: EngineLiveness = !snap.ok
		? livenessFromError(snap.message)
		: snap.s?.alive === true
			? "live"
			: snap.s?.alive === false
				? "terminal"
				: "unknown";

	const state = await readRepoWorkingState(conn, { repo: input.repo, sessionId: input.claim.sessionId }).catch(() => null);
	return { engine, changedFiles: state ? state.changedFiles : null };
}

/** Cache the verdict on the session so a listing can report it without reaching a machine. */
async function noteRecoveryState(env: Env, sessionId: string, state: string, detail: string): Promise<void> {
	await env.DB.prepare("UPDATE coding_sessions SET recovery_state = ?2, recovery_detail = ?3 WHERE id = ?1")
		.bind(sessionId, state, clipMarked(detail, HANDOFF_DETAIL_CHARS))
		.run()
		.catch(() => undefined);
}

/**
 * Clear a claim that has been answered.
 *
 * `resolvedBy` is the run that recovered it, recorded rather than nulled so the attribution survives
 * ("#982 did not start clean here — it continued #978"). A confirmed-clean handover passes null: no
 * run recovered anything, there was simply nothing left to recover.
 */
export async function releaseRecoveryClaim(
	env: Env,
	input: { instanceId: string; userId: string; sessionId: string; resolvedBy: string | null; state: string; detail: string; now?: number },
): Promise<void> {
	await env.DB.prepare(
		`UPDATE coding_sessions
		    SET recovered_by_run_id = ?4, recovery_released_at = ?7, recovery_state = ?5, recovery_detail = ?6
		  WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3`,
	)
		.bind(input.sessionId, input.instanceId, input.userId, input.resolvedBy, input.state, clipMarked(input.detail, HANDOFF_DETAIL_CHARS), input.now ?? Date.now())
		.run()
		.catch(() => undefined);
	await closeWorkCards(env, input.instanceId, input.userId, [recoveryCardId(input.sessionId)], "completed", { openOnly: true });
}

/**
 * The board card for work nobody has accounted for.
 *
 * Written when a real objective was actually BLOCKED by it, not when the claim is raised: a swept
 * run already closes its own session card, and a second card on every sweep would be noise that
 * teaches people to ignore the one that matters. `needs_human`, because that is what it is.
 */
async function upsertRecoveryCard(env: Env, input: { instanceId: string; userId: string; repoName: string; claim: RecoveryClaim; detail: string }): Promise<void> {
	const now = new Date().toISOString();
	const subject = input.claim.issue != null ? `issue #${input.claim.issue}` : `run ${input.claim.runId}`;
	await upsertWorkCard(env, {
		instanceId: input.instanceId,
		userId: input.userId,
		id: recoveryCardId(input.claim.sessionId),
		task: {
			id: recoveryCardId(input.claim.sessionId),
			type: "coding.recovery",
			status: "needs_human",
			title: `Unfinished work in ${input.repoName} — ${subject}`.slice(0, 200),
			subtitle: input.claim.objective.slice(0, 120),
			description: cardDetail(input.detail),
			input: { runId: input.claim.runId, sessionId: input.claim.sessionId, issue: input.claim.issue },
			createdAt: now,
			updatedAt: now,
		},
	});
}

export interface HandoffDecision extends HandoffVerdict {
	/** The owner the verdict is about, or null when there was nothing claiming this checkout. */
	claim: RecoveryClaim | null;
}

/**
 * The admission check: may this objective start on this repo?
 *
 * Every candidate owner is evaluated and the MOST RESTRICTIVE answer wins, because they can be
 * different sessions: an old ended session may hold the claim while a live one holds a running
 * engine, and releasing the first while ignoring the second is the whole defect.
 *
 * NEVER THROWS. A read that fails returns "nothing claims this", i.e. the behaviour before this
 * existed — a broken bookkeeping query must not lock every coding agent out of its own repo.
 */
export async function resolveRepoHandoff(
	env: Env,
	input: { instanceId: string; userId: string; repo: CodingRepo; incoming: IncomingWork; runId?: string | null; now?: number },
): Promise<HandoffDecision> {
	const safe: HandoffDecision = { state: "safe_to_start_next", admit: true, recovering: false, release: false, detail: "", claim: null };
	const candidates: RecoveryClaim[] = [];
	try {
		const [live, closed] = await Promise.all([
			getHeartbeatLostClaim(env, input.instanceId, input.userId, input.repo.id, input.now),
			getRecoveryClaim(env, input.instanceId, input.userId, input.repo.id),
		]);
		if (live) candidates.push(live);
		if (closed && closed.runId !== live?.runId) candidates.push(closed);
	} catch {
		return safe;
	}
	if (!candidates.length) return safe;

	// One connection for every probe in this pass.
	const conn = await getBoundRunnerConn(env, input.instanceId, input.userId).catch(() => null);
	let blocked: HandoffDecision | null = null;
	let recovering: HandoffDecision | null = null;
	for (const claim of candidates) {
		const probe = await probeHandoff(env, { instanceId: input.instanceId, userId: input.userId, repo: input.repo, claim, conn }).catch(
			() => ({ engine: "unknown" as EngineLiveness, changedFiles: null }),
		);
		const verdict = handoffVerdict(claim, probe, input.incoming);
		const decision: HandoffDecision = { ...verdict, claim };
		if (verdict.release) {
			await releaseRecoveryClaim(env, {
				instanceId: input.instanceId,
				userId: input.userId,
				sessionId: claim.sessionId,
				resolvedBy: null,
				state: verdict.state,
				detail: `Nothing left to recover from run ${claim.runId}: its engine is stopped and the checkout is clean.`,
			});
			continue;
		}
		await noteRecoveryState(env, claim.sessionId, verdict.state, verdict.detail);
		if (!verdict.admit) {
			// Refuse on the most restrictive, and keep the first refusal: candidates are ordered
			// live-owner first, which is the one whose engine is actually holding the session.
			blocked = blocked ?? decision;
			if (verdict.state === "interrupted_awaiting_recovery") {
				await upsertRecoveryCard(env, { instanceId: input.instanceId, userId: input.userId, repoName: input.repo.name, claim, detail: verdict.detail });
			}
		} else if (verdict.recovering) {
			recovering = recovering ?? decision;
			if (input.runId) {
				await releaseRecoveryClaim(env, {
					instanceId: input.instanceId,
					userId: input.userId,
					sessionId: claim.sessionId,
					resolvedBy: input.runId,
					state: verdict.state,
					detail: verdict.detail,
				});
			}
		}
	}
	return blocked ?? recovering ?? safe;
}

/**
 * The stored handover state for a listing (the objective queue, the board) — NO probe.
 *
 * A listing must not make a relay round trip per repo, and the four states are exactly what a
 * reader waiting on a queue needs: `working` (something owns it and is alive), `stalled`,
 * `interrupted_awaiting_recovery`, `safe_to_start_next`. Cached from the last admission attempt,
 * which is the moment the question was last actually asked.
 */
export async function storedHandoff(
	env: Env,
	instanceId: string,
	userId: string,
	repoId: string,
	now = Date.now(),
): Promise<{ state: string; detail: string; runId: string; issue: number | null; sessionId: string } | null> {
	const row = await env.DB.prepare(
		`SELECT id AS session_id, status AS session_status, recovery_run_id AS run_id, recovery_issue AS issue,
		        recovery_objective AS objective, recovery_reason AS reason, recovery_at AS at,
		        recovery_state AS state, recovery_detail AS detail
		   FROM coding_sessions
		  WHERE repo_id = ?1 AND instance_id = ?2 AND user_id = ?3
		    AND recovery_run_id IS NOT NULL AND recovery_released_at IS NULL
		  ORDER BY recovery_at DESC LIMIT 1`,
	)
		.bind(repoId, instanceId, userId)
		.first<ClaimRow & { state: string | null; detail: string | null }>()
		.catch(() => null);
	if (row?.run_id) {
		const claim = toClaim(row, "interrupted");
		return {
			// Un-probed since the claim was raised: the honest word is the one that says a person is
			// needed, not `safe_to_start_next`.
			state: row.state || "interrupted_awaiting_recovery",
			detail: row.detail || `Run ${claim.runId} was closed as ${claim.reason} and nothing has confirmed what it left behind.`,
			runId: claim.runId,
			issue: claim.issue,
			sessionId: claim.sessionId,
		};
	}
	const live = await getHeartbeatLostClaim(env, instanceId, userId, repoId, now).catch(() => null);
	if (live) {
		return {
			state: "stalled",
			detail: `Run ${live.runId} still reads as running but its orchestrator has not reported for over ${Math.round(STALE_DRIVER_MS / 60_000)} minutes.`,
			runId: live.runId,
			issue: live.issue,
			sessionId: live.sessionId,
		};
	}
	return null;
}
