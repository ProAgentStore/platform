// Somebody has to reap a coding session (#275).
//
// #271 made a run end only the session it OPENED. Correct — a human who opens a session by hand
// and watches a background job close it has had their thing taken away. But ending-every-run was
// also, accidentally, the only thing that reaped sessions, and the fix replaced it with nothing.
// What was left ending a session afterwards:
//
//   • the user clicking Kill (`/sessions/:id/end`)
//   • a run closing a session it opened
//   • `reconcileOrphanedSessions` — and its ONLY caller is `/coding/diagnostics`, behind the 🩺
//     Sessions panel. It ran when a human opened a specific console panel.
//
// So for the workflow #271 exists to enable — delegate through chat/MCP, never open the Coding tab
// — nothing reaped anything, and a `claude --dangerously-skip-permissions` child process stayed
// resident on the user's laptop indefinitely, one per repo, accumulating context forever.
//
// THE POLICY, stated rather than inherited:
//
//   1. A session is reaped when NOTHING HAS TOUCHED IT for {@link IDLE_SESSION_MS}. Idle means no
//      capture poll, no message, no run, no Co-pilot turn, no timeline read — see
//      `touchSessionActivity`. It does NOT mean "no work in flight": a Pilot mid-run captures every
//      two seconds, and a human watching the terminal polls every three, so anything anyone is
//      actually looking at keeps itself alive simply by being looked at. That is what makes reaping
//      safe, and it is why the signal had to be interaction rather than a lifecycle timestamp.
//
//   2. WHO OPENED IT DOES NOT CHANGE THE ANSWER. Ownership decides who may close a session DURING a
//      run (#271's rule, unchanged). Afterwards, an unattended engine costs the same whoever
//      started it, and the one argument for treating a run-opened session more harshly cuts the
//      other way: #271's own reasoning is that "a failed run is the worst possible moment to take
//      the session away — that is exactly when they want to look at the terminal". Short-cycling
//      run-opened sessions would break precisely that. One window, no opener column, no second
//      weaker notion of ownership sitting next to the run-scoped one.
//
//   3. ORPHAN RECONCILIATION MOVES ONTO THE CRON. Detecting that the runner no longer tracks an
//      `active` session must not depend on a human opening a diagnostics panel.
//
// Both halves sit in the per-minute cron next to `runStaleRunSweep`, which exists for exactly this
// class of bug: "a row stuck at `running` forever tells every supervisor its subordinate is still
// working".
import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS } from "./runner-client.js";
import { endSession, listIdleSessions, listInstancesWithQuietSessions, reconcileOrphanedSessions } from "./coding-store.js";
import { appendTimeline } from "./coding-timeline.js";
import { logUnhandled } from "./on-error.js";
import type { Env } from "../types.js";

/**
 * How long a coding session may go untouched before it is closed.
 *
 * Six hours, and the number is a decision, not a default. Long-lived sessions have a real benefit —
 * a warm engine holds its context, so the next delegated goal starts where the last one left off —
 * so the window is set by the longest legitimate silence rather than by tidiness:
 *
 *   • A Pilot driving a run is never silent (it captures every 2s), so no run of any length is at
 *     risk. Neither is a human with the session open, for the same reason.
 *   • The exposed case is a human who walked away from a BACKGROUNDED console tab, which stops
 *     polling. Six hours is longer than any within-day break — lunch, a long meeting, an afternoon
 *     on something else — and shorter than a night, so a session abandoned at the end of the day is
 *     reclaimed before morning while one you left at noon is still there when you get back.
 *   • The two errors are asymmetric. Reaping late costs an idle process on one laptop, bounded at
 *     one per repo. Reaping early costs a live CLI context that cannot be recovered, because the
 *     next session gets a new id and starts cold.
 */
export const IDLE_SESSION_MS = 6 * 60 * 60_000;

/** How quiet a session must be before we spend a relay round trip asking whether it still exists. */
export const ORPHAN_QUIET_MS = 5 * 60_000;

/** Bound on one tick, so a backlog drains over several minutes instead of one huge pass. */
const REAP_LIMIT = 50;
const RECONCILE_LIMIT = 25;

export interface CodingSweepResult {
	reaped: number;
	reconciled: number;
	/** Instances whose runner answered but whose reply we refused to act on. */
	skipped: number;
}

/**
 * The ids the runner says it is tracking, or NULL meaning "it did not tell us".
 *
 * The distinction is the whole safety of the reconcile. `reconcileOrphanedSessions` ends every
 * `active` session NOT in the set it is given, so an empty set means "end everything". A runner
 * that answers with a body missing `tracked` — an older build, a partial reply, a shape change —
 * would produce exactly that empty set. Opening the console's diagnostics panel could trip it once;
 * a cron would trip it every minute, on every instance, forever. So an unrecognisable answer is a
 * skip, never an empty set.
 */
export function trackedSessionIds(diagnostics: unknown): string[] | null {
	const d = diagnostics as { tracked?: unknown } | null | undefined;
	if (!d || !Array.isArray(d.tracked)) return null;
	const ids: string[] = [];
	for (const t of d.tracked as Array<{ sessionId?: unknown }>) {
		if (t && typeof t.sessionId === "string" && t.sessionId) ids.push(t.sessionId);
	}
	return ids;
}

/**
 * Close one idle session: stop the engine on the machine, then close the row.
 *
 * The runner call is the point of the exercise — closing only the D1 row would tidy the database
 * and leave the actual child process running, which is the leak. It is best-effort: a session whose
 * machine is offline has no process left to stop, and its row still has to stop claiming to be
 * active.
 *
 * But "offline machine, nothing to stop" and "connected machine, /coding/end failed" were reported
 * identically, and the timeline sentence asserts the second case never happens: it told the human
 * "the engine process was released" about a child process still running on their laptop — the exact
 * leak the paragraph above excludes, written into the session's own durable record. The row still
 * closes (it must stop claiming to be active), but only a stop that actually happened is claimed.
 */
async function reapSession(
	env: Env,
	s: { id: string; instanceId: string; userId: string; runnerNode: string | null },
	idleHours: number,
): Promise<boolean> {
	const conn = await getBoundRunnerConn(env, s.instanceId, s.userId).catch(() => null);
	const stopped = conn
		? await callRunner(conn, "/coding/end", { sessionId: s.id }, { timeoutMs: READ_TIMEOUT_MS }).then(() => true, () => false)
		: true; // no live runner → no process of ours left to stop
	const closed = await endSession(env, s.instanceId, s.userId, s.id, "ended").catch(() => false);
	if (closed) {
		// Say so where the human will look. A session that vanished with no explanation is how a
		// reaper earns a bug report; the timeline is the session's own record and survives it.
		await appendTimeline(env, {
			sessionId: s.id,
			instanceId: s.instanceId,
			userId: s.userId,
			type: "outcome",
			content: stopped
				? `Session closed automatically after ${idleHours} hours with no activity — the engine process was released. Start a new session to pick the work back up.`
				: `Session closed automatically after ${idleHours} hours with no activity, but the engine could not be stopped on your machine — it may still be running. Check it there if you need the process gone.`,
		}).catch(() => undefined);
	}
	return closed;
}

export async function sweepCodingSessions(env: Env, now: number = Date.now()): Promise<CodingSweepResult> {
	const out: CodingSweepResult = { reaped: 0, reconciled: 0, skipped: 0 };
	const idleHours = Math.round(IDLE_SESSION_MS / 3_600_000);

	const idle = await listIdleSessions(env, now - IDLE_SESSION_MS, REAP_LIMIT).catch(() => []);
	for (const s of idle) {
		if (await reapSession(env, s, idleHours)) out.reaped++;
	}

	// Reconcile AFTER reaping, over what is left: the two sweeps overlap (a long-idle session is
	// also a quiet one) and doing it in this order means the reconcile never spends a relay call
	// asking about sessions that were just closed.
	const instances = await listInstancesWithQuietSessions(env, now - ORPHAN_QUIET_MS, RECONCILE_LIMIT).catch(() => []);
	for (const { instanceId, userId } of instances) {
		const conn = await getBoundRunnerConn(env, instanceId, userId).catch(() => null);
		// No live runner means "not tracked" carries no information — the runner is simply not there
		// to track anything. Reconciling here would reap every session of every offline machine,
		// which is the precondition `reconcileOrphanedSessions` documents and the route honours.
		if (!conn) continue;
		const diag = await callRunner(conn, "/coding/diagnostics", undefined, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null);
		const tracked = trackedSessionIds(diag);
		if (tracked === null) {
			out.skipped++;
			continue;
		}
		const reaped = await reconcileOrphanedSessions(env, instanceId, userId, tracked).catch(() => []);
		out.reconciled += reaped.length;
	}
	return out;
}

/** Cron entry point — never throws, logs to the durable error log like the other sweeps. */
export async function runCodingSessionSweep(env: Env): Promise<void> {
	try {
		await sweepCodingSessions(env);
	} catch (err) {
		await logUnhandled(env, err, { path: "scheduled:coding-sessions", method: "CRON" }).catch(() => undefined);
	}
}
