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
import { accountTimeZone } from "./account-timezone.js";
import { RESUME_WINDOW_MS, resolveSessionContinuity } from "./coding-session-continuity.js";
import { codingSessionLink } from "./console-links.js";
import { notifyUser } from "../routes/push.js";
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
 * The opening words of every sentence a reap writes, and the ONLY handle another surface has on
 * "this was taken away by the platform, not by you" (#407).
 *
 * The timeline entry was written for the Co-pilot view, which is the one place a chat user never
 * looks — so from chat the work simply stopped existing and the next question failed for a reason
 * nothing had stated. `lastIdleReapForRepo` reads it back, and both live here because a marker
 * whose writer and reader are in different files is a marker that drifts. There is deliberately NO
 * new column: the fact is already durable, it was just unreadable from the other side.
 *
 * SLEEP, not death (#695). This row is the last line of the repo history a returning user reads,
 * and it used to open "Session closed automatically after" — teaching the noun that #257 and #408
 * went to trouble to make unnecessary, in the one place the user had no way to avoid reading it.
 * Nothing ended: the engine was released, the conversation is kept for {@link RESUME_WINDOW_MS},
 * and the next engagement continues it.
 */
export const IDLE_REAP_PREFIX = "Went to sleep after";

/**
 * Prefixes this marker has been spelled with BEFORE, which `lastIdleReapForRepo` must still match.
 *
 * Never delete an entry. The marker is not a constant the code merely agrees on — it is the literal
 * text of rows already written into `coding_timeline` in production, and the reader is a `LIKE`. So
 * rewording {@link IDLE_REAP_PREFIX} without carrying the old spelling here does not "rename" the
 * marker; it makes every reap written before the rename invisible, and the chat surface goes quiet
 * again for exactly the users #407 was about.
 */
export const LEGACY_IDLE_REAP_PREFIXES = ["Session closed automatically after"] as const;

/**
 * What the reap tells the human, in the repo's own record.
 *
 * Two things it deliberately does NOT do (#695):
 *
 *   • It does not instruct. The old sentence ended "Start a new session to pick the work back up",
 *     which was both an instruction the user has nothing to do about and a false description of
 *     what happens — the platform reattaches by itself, and "new" is the opposite of the resume
 *     `resolveSessionContinuity` performs. An announcement the user must act on, for an action the
 *     platform already takes, is how a returning user concluded their work was gone.
 *   • It does not promise the conversation. Whether the next open continues it is
 *     `resolveSessionContinuity`'s decision, made later against facts this moment does not have —
 *     which engine gets launched, and how long the user stays away. The reassurance belongs where
 *     it can be true: the notice on re-open (#697) and the sleep notification (#698).
 *
 * `engineStopped` is not cosmetic. "Offline machine, nothing of ours left to stop" and "connected
 * machine, `/coding/end` failed" close the same row, and claiming "the engine process was released"
 * about a child still running on someone's laptop writes the leak into the record that is supposed
 * to disclose it. That branch keeps its ask — a stray process on somebody's hardware is the one
 * thing here they genuinely have to know.
 */
export function idleReapNotice(idleHours: number, engineStopped: boolean): string {
	const head = `${IDLE_REAP_PREFIX} ${idleHours} hours with no activity`;
	return engineStopped
		? `${head} — the engine on your machine was released.`
		: `${head}, but the engine could not be stopped on your machine — it may still be running. Check it there if you need the process gone.`;
}

/** One repo the sweep put to sleep, as the notification needs to describe it (#698). */
export interface SleptRepo {
	instanceId: string;
	/** What the owner calls the agent in the console — their rename, else the agent's name. */
	instanceName: string | null;
	repoName: string | null;
	/**
	 * When the conversation stops being resumable, or NULL when there is no conversation to keep.
	 *
	 * Null is not "unknown" — it is a raw engine (Codex, Grok, a custom command), whose history is
	 * whatever scrolled past on stdout. Promising those users their conversation is safe would be a
	 * confident false statement at the exact moment they are deciding whether to write their
	 * context down.
	 */
	keptUntil: number | null;
	/** `/coding/end` was refused by a CONNECTED machine — a child process may still be resident. */
	strayProcess: boolean;
}

/**
 * The deadline as a date AND a time, in the owner's zone (#698).
 *
 * The issue's sketch was "kept until 20 Aug", and a bare date is the tempting form — but the window
 * expires at an instant, and it is 03:07 in the example that produced this issue. A user reading
 * "until 20 Aug" and coming back on the evening of the 20th would find the conversation gone,
 * having been told it would be there. The extra five characters are what makes the sentence a
 * promise the platform can keep.
 *
 * No zone → UTC, and it SAYS UTC, for the reason `formatLocal` and `accountTimeZone` both give: a
 * silently-assumed zone is a ten-hour error, and "nobody has told us" is a first-class state.
 */
export function sleepDeadlineLabel(ms: number, timeZone?: string): string {
	const opts: Intl.DateTimeFormatOptions = {
		timeZone: timeZone || "UTC",
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	};
	const render = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", o).format(ms).replace(/,\s*$/, "");
	try {
		return `${render(opts)}${timeZone ? "" : " UTC"}`;
	} catch {
		// An invalid stored zone. Fall back rather than lose the notification over a label.
		return `${render({ ...opts, timeZone: "UTC" })} UTC`;
	}
}

/** "a", "a and b", "a, b and c", "a, b, c and 2 more" — bounded, because this goes in a push body. */
function joinNames(names: string[], max = 3): string {
	const shown = names.slice(0, max);
	const rest = names.length - shown.length;
	if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
	if (shown.length <= 1) return shown[0] ?? "";
	return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/**
 * ONE notification for everything this sweep put to sleep for one owner (#698).
 *
 * ── Why the reap needed a channel at all
 *
 * The reap releases a process on the USER'S OWN MACHINE, six hours after they stopped looking, and
 * its only record was a row in the session's own timeline — visible exclusively to someone who had
 * already come back and opened that repo. The owner found out the next morning by opening a dead
 * pane and asking what had happened. A decision taken about somebody's computer while they are not
 * watching is the canonical thing a notification is for.
 *
 * ── What it says, and what it deliberately does not
 *
 * NOT "a session ended". The user does not need to know a process was released — #695 removed that
 * vocabulary from the timeline row for the same reason. What they need is whether the work is safe
 * and FOR HOW LONG, which is computable: `RESUME_WINDOW_MS` from the same `last_activity_at` the
 * reaper measured idleness against. The stray-process branch keeps its ask, because that one is
 * genuinely theirs to act on and nothing else carries it.
 *
 * ── BATCHED PER OWNER PER SWEEP, which is the judgement the issue leaves open
 *
 * People stop working all at once, so one evening's repos share a last-activity window and idle out
 * in the same per-minute tick — batching there is what turns "three separate 3am pings" into one.
 * The rejected alternative was suppressing a repo whose run already reported its own outcome: it
 * answers a different question (it asks whether the RUN was reported, not whether the machine was
 * touched), it needs a query nobody has, and it still lets N repos produce N pings. Batching per
 * INSTANCE was rejected for the second half of that: a user with five coding agents still gets
 * five.
 *
 * The residual — repos that idle out a few ticks apart — is caught by the caller passing a STABLE
 * event key, so `notifyUser`'s duplicate window collapses the interruption while still writing
 * every row. The bell keeps the full record; the phone buzzes once.
 *
 * Returns null for an empty batch so the caller has nothing to decide.
 */
export function sleepNotification(
	slept: SleptRepo[],
	timeZone?: string,
): { title: string; body: string; url?: string } | null {
	if (slept.length === 0) return null;

	const instances = [...new Set(slept.map((s) => s.instanceId))];
	const agentName = slept.find((s) => s.instanceName)?.instanceName ?? "An agent";
	const repos = slept.map((s) => s.repoName || "a repo");

	const title =
		instances.length > 1
			? `😴 ${instances.length} agents went to sleep`
			: slept.length > 1
				? `😴 ${agentName} went to sleep on ${slept.length} repos`
				: `😴 ${agentName} went to sleep`;

	// The EARLIEST deadline across the batch. "Kept until X" has to be true of everything the
	// sentence covers, and the latest one would over-promise for every other repo in it.
	const deadlines = slept.map((s) => s.keptUntil).filter((d): d is number => typeof d === "number");
	const kept = deadlines.length
		? ` ${deadlines.length === slept.length && slept.length > 1 ? "Your conversations are" : "Your conversation is"} kept until ${sleepDeadlineLabel(Math.min(...deadlines), timeZone)}.`
		: "";

	const stray = slept.filter((s) => s.strayProcess).length;
	const strayClause = stray
		? ` ${stray === 1 ? "One engine" : `${stray} engines`} could not be stopped on your machine and may still be running — check there if you need the process gone.`
		: "";

	return {
		title,
		body: `${joinNames(repos)}.${kept}${strayClause}`,
		// There is no page that shows every sleeping repo across agents, so a batch spanning several
		// instances gets no link rather than an arbitrary one.
		url: instances.length === 1 ? codingSessionLink(instances[0]) : undefined,
	};
}

/**
 * When this repo's conversation stops being resumable, or null when it has none to keep.
 *
 * Asks {@link resolveSessionContinuity} rather than re-deriving the rule, and asks it as the NEXT
 * OPEN will: would relaunching the same engine against this session continue it? That is the only
 * question the notification's promise depends on, and answering it here with a second copy of
 * "claude is the engine with a resume protocol" is how the promise and the behaviour drift apart.
 */
export function resumeDeadlineFor(s: { id: string; clientType: string; lastActivityAt: number | null }): number | null {
	if (s.lastActivityAt == null) return null;
	const decision = resolveSessionContinuity({
		engine: s.clientType,
		previous: { id: s.id, clientType: s.clientType, status: "ended", lastActivityAt: s.lastActivityAt },
		// AT the moment of last activity, not now: the reap fires six hours in, and asking "is it
		// resumable right now" would be a different question with the same answer today and a
		// different one if either window ever moves.
		now: s.lastActivityAt,
	});
	return decision.mode === "resume" ? s.lastActivityAt + RESUME_WINDOW_MS : null;
}

/**
 * Was this repo's MOST RECENT finished session the reaper's doing (#407)?
 *
 * Deliberately "most recent", not "any": a repo that was reaped last week and has had three
 * ordinary sessions since must not have that week-old sentence attached to today's answer. So the
 * newest `ended`/`error` session is selected first and then asked whether it carries the marker —
 * rather than selecting the newest session that carries it, which is the same query with the
 * opposite meaning.
 *
 * `suspended` is excluded with `active`: a session relocated by `pags up --force` has not finished
 * and has no `ended_at` to order by.
 */
export async function lastIdleReapForRepo(
	env: Env,
	instanceId: string,
	userId: string,
	repoId: string,
): Promise<{ sessionId: string; endedAt: string | null } | null> {
	// Every spelling the marker has ever had, current first. See `LEGACY_IDLE_REAP_PREFIXES`.
	const markers = [IDLE_REAP_PREFIX, ...LEGACY_IDLE_REAP_PREFIXES].map((p) => `${p}%`);
	const matches = markers.map((_, i) => `t.content LIKE ?${4 + i}`).join(" OR ");
	const row = await env.DB.prepare(
		`SELECT s.id AS session_id, s.ended_at AS ended_at,
		        (SELECT COUNT(*) FROM coding_timeline t
		          WHERE t.session_id = s.id AND t.type = 'outcome' AND (${matches})) AS reaped
		   FROM coding_sessions s
		  WHERE s.instance_id = ?1 AND s.user_id = ?2 AND s.repo_id = ?3 AND s.status IN ('ended', 'error')
		  ORDER BY s.ended_at DESC, s.updated_at DESC LIMIT 1`,
	)
		.bind(instanceId, userId, repoId, ...markers)
		.first<{ session_id: string; ended_at: string | null; reaped: number }>();
	if (!row?.reaped) return null;
	return { sessionId: row.session_id, endedAt: row.ended_at ?? null };
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
): Promise<{ closed: boolean; stopped: boolean }> {
	const conn = await getBoundRunnerConn(env, s.instanceId, s.userId).catch(() => null);
	const stopped = conn
		? await callRunner(conn, "/coding/end", { sessionId: s.id }, { timeoutMs: READ_TIMEOUT_MS }).then(() => true, () => false)
		: true; // no live runner → no process of ours left to stop
	const closed = await endSession(env, s.instanceId, s.userId, s.id, "ended").catch(() => false);
	if (closed) {
		// Say so where the human will look. A repo whose engine vanished with no explanation is how
		// a reaper earns a bug report; the timeline is the session's own record and survives it.
		await appendTimeline(env, {
			sessionId: s.id,
			instanceId: s.instanceId,
			userId: s.userId,
			type: "outcome",
			content: idleReapNotice(idleHours, stopped),
		}).catch(() => undefined);
	}
	return { closed, stopped };
}

/**
 * The stable event key every sleep notification carries (#698).
 *
 * Constant per user on purpose: `notifyUser` derives its dedupe key from this, so two batches a few
 * ticks apart collapse into ONE interruption inside the duplicate window while both still write
 * their row. That is the residual the per-sweep batching cannot catch by itself — repos that idle
 * out several minutes apart — and it is caught by the mechanism that already exists for it rather
 * than by a second timer here.
 */
export const SLEEP_NOTIFY_KEY = "coding-sleep";

/**
 * Tell each owner, once, what this sweep put to sleep.
 *
 * Best-effort throughout: a notification that cannot be built or sent must never fail the reap. The
 * reap is about a process on somebody's laptop; the notification is about them knowing. Losing the
 * second is a visibility bug, losing the first is the leak #275 exists to close.
 */
async function announceSleep(env: Env, slept: Map<string, SleptRepo[]>): Promise<void> {
	for (const [userId, repos] of slept) {
		const zone = await accountTimeZone(env, userId).catch(() => undefined);
		const note = sleepNotification(repos, zone);
		if (!note) continue;
		// `update`, never `alert`. An alert is documented as "a human is blocked on this" and is
		// unmutable; nothing is blocked here, and a 3am ping people cannot turn off is how they
		// learn to stop reading these (the same reasoning `coding-pause.ts` applies to a usage-limit
		// park). A "coding" mute silences it, which is the point.
		await notifyUser(env, userId, "coding", note.title, note.body, note.url, { key: SLEEP_NOTIFY_KEY }).catch(
			() => undefined,
		);
	}
}

export async function sweepCodingSessions(env: Env, now: number = Date.now()): Promise<CodingSweepResult> {
	const out: CodingSweepResult = { reaped: 0, reconciled: 0, skipped: 0 };
	const idleHours = Math.round(IDLE_SESSION_MS / 3_600_000);

	const idle = await listIdleSessions(env, now - IDLE_SESSION_MS, REAP_LIMIT).catch(() => []);
	// Collected across the whole tick, then announced once per owner — see `sleepNotification`.
	const slept = new Map<string, SleptRepo[]>();
	for (const s of idle) {
		const { closed, stopped } = await reapSession(env, s, idleHours);
		if (!closed) continue;
		out.reaped++;
		const list = slept.get(s.userId) ?? [];
		list.push({
			instanceId: s.instanceId,
			instanceName: s.instanceName,
			repoName: s.repoName,
			keptUntil: resumeDeadlineFor(s),
			strayProcess: !stopped,
		});
		slept.set(s.userId, list);
	}
	await announceSleep(env, slept).catch(() => undefined);

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
