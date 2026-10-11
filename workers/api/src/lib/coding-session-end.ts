// Ending a coding session — ONE implementation, for the route and for the agent's own tool (#540).
//
// This is `POST /:instanceId/coding/sessions/:sessionId/end`'s body, moved here unchanged, because
// #540 gives the agent a tool that must end a session exactly the way the console's End button
// does. The alternative — a second, tool-shaped copy — would have had to restate four things that
// each exist because they were once missing, and a copy that restates them today is a copy that
// stops restating them at the next change:
//
//   1. the closing turn's SPEND is drained and ledgered (#267): a session's last turn routinely
//      completes after the final capture poll, so ending without a drain loses the tail of EVERY
//      session — a bias, not noise;
//   2. WHO PAID for it rides along (#554), `?? null` and never a fallback to the configured preset,
//      because what was configured is not what resolved;
//   3. the engine's ACTS are drained too (#294) — a session very often ends with the consequential
//      one (push, open the PR, merge it);
//   4. a failed stop is reported honestly rather than swallowed: the row still has to close (a
//      session the user ended must stop claiming to be active), but an orphaned CLI that is still
//      editing the repo is not a clean stop and must not be reported as one.
//
// `lib/*` may not import `routes/*` (the rule `git-credentials.ts` states), so the session's runner
// is resolved through `getRunnerConn` directly — which is all `routes/coding-shared.ts`'s
// `getSessionRunnerConn` is: the live-checked resolve for the machine the session is stamped to.
// That stamp is authoritative here for the same reason it is on `/message` and `/restart`: this
// addresses a child process that exists on ONE machine.
import { getRunnerConn, callRunner } from "./runner-client.js";
import { endSession, getSession } from "./coding-store.js";
import { releaseReservation, repoOwners } from "./coding-ownership.js";
import { tryDequeueAndStart, type QueueDrainResult } from "./objective-queue-start.js";
import { normalizeRunnerNode } from "./runtime-nodes.js";
import { recordEngineActs, sanitizeEngineActs } from "./engine-acts.js";
import { sanitizeEngineUsage } from "./engine-usage.js";
import { appendEngineUsageTimeline } from "./coding-timeline.js";
import { recordEngineUsage } from "./usage.js";
import { logError } from "./error-log.js";
import type { EngineAuthResolved } from "./coding-engines.js";
import type { CodingSessionRecord } from "./coding-types.js";
import type { Env } from "../types.js";

export interface EndCodingSessionResult {
	/** Did the D1 row actually move out of `active`/`suspended`? False for an already-ended session. */
	ok: boolean;
	/**
	 * Did the engine on the machine confirm it stopped?
	 *
	 * `null` when there was no reachable runner to ask — which is NOT the same as "it stopped", and
	 * is why this is three-valued. A machine that is off is not running the engine; a machine that
	 * is up and did not answer may well still be.
	 */
	engineStopped: boolean | null;
	/** Present only when the engine did not confirm the stop. The exact sentence the API returns. */
	warning?: string;
	/** The session as read, so a caller can name the repo/machine without a second lookup. */
	session: CodingSessionRecord | null;
	/** The session existed and its row was already out of `active`/`suspended`: nothing needed closing. */
	alreadyEnded: boolean;
	/** What became of the direct claim this end observed (#1015); null when there was none. */
	directTurn: DirectTurnOutcome | null;
}

/**
 * The direct claim an end observed, and what the end did with it (#1015). `queue` is present only when
 * the release happened AND a drain decision was made; it is the drain's own result, so admission is
 * reported only when a run actually started.
 */
export type DirectTurnOutcome =
	| { turnId: string; released: true; queue: { attempted: false; reason: "repo_still_owned" } | ({ attempted: true } & QueueDrainResult) }
	/** `stop_not_confirmed`: no stamped machine confirmed the stop. `superseded`: the claim changed since it was read. */
	| { turnId: string; released: false; reason: "stop_not_confirmed" | "superseded" };

export async function endCodingSession(
	env: Env,
	input: { instanceId: string; userId: string; sessionId: string },
): Promise<EndCodingSessionResult> {
	const { instanceId, userId, sessionId } = input;
	const session = await getSession(env, instanceId, userId, sessionId);
	const conn = session ? await getRunnerConn(env, instanceId, userId, session.runnerNode ?? null) : null;
	// The direct claim as it stood BEFORE the stop (#1015): the stop is evidence about THIS turn's
	// engine, so only this turn id may be released on it — a send admitted after the read is not.
	const claim = session
		? await env.DB.prepare("SELECT direct_turn_id FROM coding_sessions WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
				.bind(sessionId, instanceId, userId)
				.first<{ direct_turn_id: string | null }>()
		: null;
	// Stopping the engine is the POINT of ending a session; closing only the D1 row tidies the
	// database and leaves the child process running (`coding-session-sweeper` says exactly this).
	let stopError: string | null = null;
	const ended = conn
		? await callRunner<{ ok?: unknown; usage?: unknown; acts?: unknown; authResolved?: unknown }>(conn, "/coding/end", { sessionId }).catch((e) => {
				stopError = e instanceof Error ? e.message : String(e);
				return null;
			})
		: null;
	// A delivered request is not a stop (#1015). The runner's `end()` answers `{ok:true, …}` — every
	// version has — so only that body confirms it; `{ok:false}`, an empty or malformed body is an
	// unconfirmed stop, which keeps the direct claim and says the engine may still be running.
	if (conn && !stopError && (ended as { ok?: unknown } | null)?.ok !== true) stopError = "the runner did not confirm the stop";
	if (stopError) {
		await logError(env, {
			source: "coding",
			userId,
			message: `Failed to stop the engine while ending session ${sessionId}: ${stopError}`,
			context: { instanceId, sessionId, runnerNode: session?.runnerNode ?? null },
		});
	}
	const usageRecords = sanitizeEngineUsage(ended?.usage);
	await recordEngineUsage(env, { userId, sessionId, instanceId, authResolved: (ended?.authResolved ?? null) as EngineAuthResolved | null }, usageRecords);
	await appendEngineUsageTimeline(env, { sessionId, instanceId, userId }, usageRecords);
	await recordEngineActs(env, { userId, sessionId, instanceId }, sanitizeEngineActs(ended?.acts)).catch(() => undefined);
	const ok = await endSession(env, instanceId, userId, sessionId);
	const directTurn =
		session && claim?.direct_turn_id
			? await releaseStoppedDirectTurn(env, {
					instanceId,
					userId,
					sessionId,
					repoId: session.repoId,
					turnId: claim.direct_turn_id,
					stopConfirmed: conn !== null && !stopError,
					stamped: session.runnerNode,
					answeredBy: conn?.runnerNode,
				})
			: null;
	return {
		ok,
		alreadyEnded: session !== null && !ok,
		directTurn,
		engineStopped: stopError ? false : conn ? true : null,
		...(stopError
			? {
					warning: `The session is closed, but the engine on ${session?.runnerNode || "your machine"} did not confirm it stopped — it may still be running. Check Diagnostics → Sessions, or \`ps\`, if the repo keeps changing.`,
				}
			: {}),
		session,
	};
}

/**
 * Release a direct claim the stamped machine has just confirmed stopped, and drain once (#1015).
 *
 * A steer on a run-driven session reserves the checkout, and `endSession` clears the run's driver
 * claim but not that reservation. Once the runner forgets the session, its watcher — if one is still
 * running, and not one that already gave up — was the only thing that could release it, so ending
 * the session (or ending it AGAIN) is the owner's exact-target way out. It acts on positive evidence
 * only: a confirmed `/coding/end` from the machine the session is stamped to. The release is keyed to
 * the turn read before the stop, so a newer send keeps its claim; only the call that actually cleared
 * it drains, and only when nothing else owns the repo — the run that drain starts then owns it, so a
 * repeat finds nothing to do. No queue entry is cancelled or reordered, and no engine is started here.
 */
async function releaseStoppedDirectTurn(
	env: Env,
	input: { instanceId: string; userId: string; sessionId: string; repoId: string; turnId: string; stopConfirmed: boolean; stamped: string | null | undefined; answeredBy: string | null | undefined },
): Promise<DirectTurnOutcome> {
	const stamped = normalizeRunnerNode(input.stamped);
	if (!input.stopConfirmed || !stamped || normalizeRunnerNode(input.answeredBy) !== stamped) return { turnId: input.turnId, released: false, reason: "stop_not_confirmed" };
	if (!(await releaseReservation(env, input.sessionId, input.turnId))) return { turnId: input.turnId, released: false, reason: "superseded" };
	const owners = await repoOwners(env, { instanceId: input.instanceId, userId: input.userId, repoId: input.repoId });
	if (owners.length) return { turnId: input.turnId, released: true, queue: { attempted: false, reason: "repo_still_owned" } };
	return { turnId: input.turnId, released: true, queue: { attempted: true, ...(await tryDequeueAndStart(env, input.instanceId, input.repoId, input.userId)) } };
}
