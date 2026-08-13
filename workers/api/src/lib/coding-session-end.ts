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
import { recordEngineActs, sanitizeEngineActs } from "./engine-acts.js";
import { sanitizeEngineUsage } from "./engine-usage.js";
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
}

export async function endCodingSession(
	env: Env,
	input: { instanceId: string; userId: string; sessionId: string },
): Promise<EndCodingSessionResult> {
	const { instanceId, userId, sessionId } = input;
	const session = await getSession(env, instanceId, userId, sessionId);
	const conn = session ? await getRunnerConn(env, instanceId, userId, session.runnerNode ?? null) : null;
	// Stopping the engine is the POINT of ending a session; closing only the D1 row tidies the
	// database and leaves the child process running (`coding-session-sweeper` says exactly this).
	let stopError: string | null = null;
	const ended = conn
		? await callRunner<{ usage?: unknown; acts?: unknown; authResolved?: unknown }>(conn, "/coding/end", { sessionId }).catch((e) => {
				stopError = e instanceof Error ? e.message : String(e);
				return null;
			})
		: null;
	if (stopError) {
		await logError(env, {
			source: "coding",
			userId,
			message: `Failed to stop the engine while ending session ${sessionId}: ${stopError}`,
			context: { instanceId, sessionId, runnerNode: session?.runnerNode ?? null },
		});
	}
	await recordEngineUsage(
		env,
		{ userId, sessionId, instanceId, authResolved: (ended?.authResolved ?? null) as EngineAuthResolved | null },
		sanitizeEngineUsage(ended?.usage),
	);
	await recordEngineActs(env, { userId, sessionId, instanceId }, sanitizeEngineActs(ended?.acts)).catch(() => undefined);
	const ok = await endSession(env, instanceId, userId, sessionId);
	return {
		ok,
		engineStopped: stopError ? false : conn ? true : null,
		...(stopError
			? {
					warning: `The session is closed, but the engine on ${session?.runnerNode || "your machine"} did not confirm it stopped — it may still be running. Check Diagnostics → Sessions, or \`ps\`, if the repo keeps changing.`,
				}
			: {}),
		session,
	};
}
