// Getting a repo to a LIVE coding session — the one place that knows how (#271).
//
// `startSessionOnRunner` used to be a private helper inside `routes/coding.ts`, reachable only by
// someone typing in the console. That is why delegation could not open a session for itself and
// had to 409 instead: the capability existed, it was just behind a route. Moved here verbatim so
// the autonomous path (`loop-drivers.ts`) and the interactive path share ONE implementation —
// a second copy would drift on exactly the details that make it work (machine-switch reclaim,
// installation tokens, engine env).
import { callRunner, getBoundRunnerConn, getRunnerConnIgnoringLiveness, relayConnected, type RunnerConn } from "./runner-client.js";
import { resolveCloneCredential } from "./git-credentials.js";
import { resolveEngine, resolveEngineEnv } from "./coding-engines.js";
import { createSession, endSession, getActiveSessionForRepo, getLastFinishedSessionForRepo, getRepo, reassignSessionNode, updateRepoClone } from "./coding-store.js";
import { IDLE_SESSION_MS, lastIdleReapForRepo } from "./coding-session-sweeper.js";
import { noSessionMessage } from "./coding-session-lifecycle.js";
import { resolveSessionContinuity, type SessionContinuity } from "./coding-session-continuity.js";
import { EMPTY_RUNTIME_FACTS, runtimeConnectivity } from "./instance-connectivity.js";
import { isRunnerUnreachable } from "./runner-unreachable.js";
import { classifySubordinateConnectivity } from "./subordinate-connectivity.js";
import { normalizeRunnerNode } from "./runtime-nodes.js";
import type { CodingRepo, CodingSessionRecord } from "./coding-types.js";
import type { Env } from "../types.js";

/**
 * What launching a session on a machine tells us back.
 *
 * `conn` was the whole return value until #408. `resumed` is here rather than in a second function
 * because it is the ONLY answer to "did the engine come up with its previous conversation", it can
 * only be known by the machine, and a caller that wants to state which one happened must not be
 * able to obtain the connection without also being handed the fact.
 */
export interface StartOnRunnerResult {
	/** The connection the session actually runs on. Null when nothing could be reached. */
	conn: RunnerConn | null;
	/**
	 * Why the launch failed, when it did (#440).
	 *
	 * Here rather than only on the repo row, because since #440 a TRANSPORT failure is deliberately
	 * NOT written to the row — and the caller still has to be able to say what went wrong. Reading
	 * it back off `coding_repos.clone_error` (what `ensureActiveSession` used to do) would now
	 * report whatever the LAST filesystem verdict said, which is a different failure, possibly days
	 * old, and would be relayed to the owner as the reason their session did not start.
	 */
	startError?: string | null;
	/**
	 * The runner CONFIRMED it launched the engine with a conversation to continue.
	 *
	 * False is the honest default for everything else, including an older `pags up`: a runner
	 * published before #408 has no `resumed` field and could not have resumed a NEW session id
	 * anyway (its resume store is keyed by that id and has no entry for one it has never seen).
	 * So "no answer" and "started clean" really are the same outcome here, and treating the absent
	 * field as false is not an assumption — it is the behaviour.
	 */
	resumed: boolean;
}

/**
 * Ensure a session is live on the user's runner: clone the repo (idempotent on
 * the runner) and launch the CLI. Returns the connection it actually used (null if
 * no runner is connected). Used both when creating a session and when re-attaching
 * an orphaned one (created while the runner was offline, or after a runner restart).
 *
 * IMPORTANT: on a machine switch this RELOCATES the session to the live machine and
 * returns THAT machine's connection — callers retrying a command must use the returned
 * conn, not one they captured earlier (which may point at the now-dead old machine).
 *
 * `opts.resumeFrom` is set ONLY by a fresh open that has decided to continue the repo's previous
 * conversation (#408). A re-attach never sets it: that path's session id IS the conversation's key
 * on the runner, so passing a predecessor could only ever override the better answer.
 */
export async function startSessionOnRunner(
	env: Env,
	instanceId: string,
	uid: string,
	session: CodingSessionRecord,
	repo: CodingRepo,
	opts?: { resumeFrom?: string | null },
): Promise<StartOnRunnerResult> {
	// IGNORING LIVENESS, deliberately (#532) — the reclaim immediately below is what acts on a dead
	// stamped node, and it probes the relay itself two lines down. Resolving live here would only
	// ask the same DO the same question twice per open.
	let conn = await getRunnerConnIgnoringLiveness(env, instanceId, uid, session.runnerNode ?? null);
	// Machine-switch reclaim. `conn` resolves from the DB (endpoint+token) even for a machine
	// that's gone offline — the `status` column isn't cleared on disconnect — so verify the
	// session's own machine actually holds a live relay socket. If it doesn't, but the user is
	// now running the agent on another machine, relocate the session there so switching laptops
	// "just works" instead of dead-ending on the offline node. `getBoundRunnerConn` is live +
	// pin-aware: pinned-elsewhere stays put (returns that node), pinned-to-this-offline → null.
	const sessionLive = session.runnerNode
		? await relayConnected(env, instanceId, session.runnerNode).catch(() => false)
		: await relayConnected(env, instanceId, null).catch(() => false);
	if (!sessionLive) {
		const fallback = await getBoundRunnerConn(env, instanceId, uid);
		if (fallback && normalizeRunnerNode(fallback.runnerNode) !== normalizeRunnerNode(session.runnerNode)) {
			await reassignSessionNode(env, instanceId, uid, session.id, fallback.runnerNode ?? null);
			session.runnerNode = fallback.runnerNode ?? null;
			conn = fallback;
		}
	}
	if (!conn) return { conn: null, resumed: false };
	// Provider-dispatched (#221): GitHub still resolves through the App installation token, and a
	// non-GitHub repo gets its own provider's credential — or none, which means "clone it
	// publicly / with whatever this machine already has", the same thing a public GitHub repo
	// has always got.
	const credential = await resolveCloneCredential(env, uid, repo);
	const engineEnv = await resolveEngineEnv(env, instanceId, uid, session);
	try {
		const started = await callRunner<{ resumed?: unknown }>(conn, "/coding/start", {
			sessionId: session.id,
			repoId: repo.id,
			// Local checkout → run in that dir (no clone). Else clone to a managed dir.
			workDir: repo.workdir || undefined,
			cloneUrl: repo.cloneUrl,
			branch: repo.branch || undefined,
			token: credential?.token,
			// The username half. An older runner ignores it and hardcodes `x-access-token`,
			// which is still correct for GitHub and happens to work for a GitLab PAT (GitLab
			// accepts any username), so a stale bundle degrades rather than breaking.
			tokenUsername: credential?.username,
			clientType: session.clientType,
			// The exact CLI command for this session's engine (Claude default, or a
			// user-configured Codex/Grok/custom). The runner spawns it.
			command: session.launchCommand || undefined,
			// Unknown to a runner older than #408, which drops it and starts clean — the behaviour
			// every re-open had before the field existed. That degradation is why the notice reads
			// the ANSWER below instead of assuming this request was honoured.
			resumeFrom: opts?.resumeFrom || undefined,
			env: engineEnv,
		});
		await updateRepoClone(env, repo.id, { cloneStatus: "ready", cloneError: null });
		return { conn, resumed: started?.resumed === true };
	} catch (e) {
		const msg = e instanceof Error ? e.message.slice(0, 300) : String(e);
		// A REPO'S STATE IS ONLY EVER WRITTEN BY SOMETHING THAT LOOKED AT THE REPO (#440).
		//
		// This catch used to store ANY exception as `clone_status = "error"`. `POST /coding/start`
		// fails for two unrelated reasons — the clone or the engine could not be brought up in that
		// directory (a fact about the repo) and the machine was not reachable (a fact about a
		// WebSocket) — and the second was being recorded as the first. Measured: `pas/platform` on
		// the Coder Home instance carried `clone_status = "error"` with
		// `clone_error = "No runner connected — run \`pags up\`"` for five days. That exact string
		// is `callRunner`'s pre-#341 503 message, deleted in b347f68, so it can only have come from
		// here; the checkout it condemns holds 18 entries and is a git work tree.
		//
		// An unreachable runner therefore takes the SAME answer `unverified` takes one file over —
		// no write at all (`cloneStatusForVerdict` returns null for it, deliberately). The cost is
		// stated rather than inferred: a genuinely broken clone that ALSO fails at the transport
		// keeps its previous status. That is silence over a false claim, the same trade
		// `onUnverified: null` already makes at list time.
		if (!isRunnerUnreachable(e)) {
			await updateRepoClone(env, repo.id, { cloneStatus: "error", cloneError: msg });
		}
		return { conn: null, resumed: false, startError: msg };
	}
}

/**
 * Should a session about to be created continue this repo's previous conversation (#408)?
 *
 * The lookup half of {@link resolveSessionContinuity}; the rule itself is pure and tested next to
 * its own reasoning. Called only on a FRESH open — a reuse or re-attach is by definition already
 * the conversation it would have continued.
 *
 * Never throws: a D1 hiccup here must degrade to "start clean", which is what every open did
 * before this existed, rather than fail the open.
 */
export async function continuityForNewSession(
	env: Env,
	instanceId: string,
	userId: string,
	repoId: string,
	engine: string,
	opts?: { forceFresh?: boolean },
): Promise<SessionContinuity> {
	// Skip the read entirely when the answer is already fixed — a Fresh start has nothing to learn
	// from the row it just ended.
	if (opts?.forceFresh) return resolveSessionContinuity({ engine, previous: null, forceFresh: true });
	const previous = await getLastFinishedSessionForRepo(env, instanceId, userId, repoId).catch(() => null);
	return resolveSessionContinuity({ engine, previous });
}

export type EnsureSessionResult =
	| {
			ok: true;
			session: CodingSessionRecord;
			opened: boolean;
			/**
			 * What was DECIDED about continuing the repo's previous conversation, and what the
			 * machine ACTUALLY did (#408). Present only on the open path — a reuse continues the
			 * conversation it is reusing, and there is no decision to report.
			 */
			continuity?: SessionContinuity;
			/** The runner confirmed the engine came up with the previous conversation. */
			resumed?: boolean;
	  }
	/**
	 * `session` is the one that EXISTS but could not be revived — set only on the re-attach path,
	 * never on a fresh open (that row is ended before we return, so handing it back would name a
	 * session that is gone). A caller with a degraded read to offer — the chat's `read_terminal`
	 * falls back to the last saved snapshot — needs its id; without it the failure is total where
	 * it used to be partial.
	 */
	| { ok: false; startError: string | null; session?: CodingSessionRecord | null };

/**
 * The repo's live session, opening one if there isn't one.
 *
 * `opened` says whether THIS call created it, and that answer is what decides who may close it
 * later (`shouldEndSessionAfterRun`). Reusing a session a human already opened must report
 * `opened: false` — otherwise the run would inherit the right to end someone else's session,
 * which is the bug rather than the fix.
 *
 * Only call this with a runner known to be connected; the caller owns the "no runner" diagnosis
 * (it has better words for it than a null return does).
 */
export async function ensureActiveSession(
	env: Env,
	instanceId: string,
	userId: string,
	repo: CodingRepo,
): Promise<EnsureSessionResult> {
	// Re-attach before handing a session over: it can be `active` in D1 while its engine process is
	// gone (runner restarted, laptop slept). Idempotent on the runner, so this is free when it
	// really is live — and it is what makes the reused path as reliable as a fresh one.
	//
	// Which only holds if the ANSWER is read. Both reuse paths discarded it twice over (the throw
	// caught, the null return unread) and returned `ok: true` regardless — so "quietly driving a
	// dead pane", the thing this re-attach exists to prevent, was still the outcome: `loop-drivers`
	// reads `ok: true` as a live engine, claims the driver, opens the run row and bills the Pilot's
	// reasoning turns against a pane that never launched. Report what the fresh path reports.
	const reattach = async (s: CodingSessionRecord): Promise<EnsureSessionResult> => {
		const started = await startSessionOnRunner(env, instanceId, userId, s, repo).catch(() => null);
		if (started?.conn) return { ok: true, session: s, opened: false };
		// The launch's OWN reason first (#440). The row is the fallback for the case this call
		// never got as far as raising one (a `.catch(() => null)` above, or a session that could
		// not be created), and it is no longer the primary source: since a transport failure is
		// not written to the row, reading it would report the last filesystem verdict instead.
		if (started?.startError) return { ok: false, startError: started.startError, session: s };
		const fresh = await getRepo(env, instanceId, userId, repo.id).catch(() => null);
		return { ok: false, startError: fresh?.cloneError ?? null, session: s };
	};

	const existing = await getActiveSessionForRepo(env, instanceId, userId, repo.id);
	if (existing) return reattach(existing);

	const conn = await getBoundRunnerConn(env, instanceId, userId).catch(() => null);
	const { command, clientType } = await resolveEngine(env, instanceId, userId, repo.defaultClient);
	let session: CodingSessionRecord;
	try {
		session = await createSession(env, instanceId, userId, {
			repoId: repo.id,
			clientType,
			launchCommand: command,
			runnerNode: conn?.runnerNode ?? null,
		});
	} catch {
		// Lost the one-active-session-per-repo race — the winner is a session this call did not
		// open, so it is reused, not owned.
		const winner = await getActiveSessionForRepo(env, instanceId, userId, repo.id);
		if (!winner) return { ok: false, startError: "could not create a session" };
		return reattach(winner);
	}

	// Resolved AFTER the insert, so the row this call just created cannot be its own predecessor
	// (`getLastFinishedSessionForRepo` only reads finished rows, but the ordering makes that a fact
	// rather than a coincidence), and BEFORE the launch, because the runner needs the answer.
	const continuity = await continuityForNewSession(env, instanceId, userId, repo.id, clientType);
	const started = await startSessionOnRunner(env, instanceId, userId, session, repo, { resumeFrom: continuity.resumeFrom });
	if (!started.conn) {
		// A session row whose engine never launched is worse than none: `getActiveSessionForRepo`
		// would hand it to every later attempt, so the repo would be permanently stuck behind a
		// session that cannot do anything. Close it and report the real reason.
		await endSession(env, instanceId, userId, session.id, "error").catch(() => undefined);
		// `startSessionOnRunner` reports WHY (clone failure, bad engine command, unreachable
		// machine) so the caller can say what actually went wrong instead of the generic "no
		// session" that sent a user chasing `pags up`. It used to be re-read off the repo row;
		// since #440 the row is not written for a transport failure, so the answer comes from the
		// call and the row is only the fallback.
		if (started.startError) return { ok: false, startError: started.startError };
		const fresh = await getRepo(env, instanceId, userId, repo.id).catch(() => null);
		return { ok: false, startError: fresh?.cloneError ?? null };
	}
	return { ok: true, session, opened: true, continuity, resumed: started.resumed };
}

/**
 * What the agent says when IT opened the session (#407).
 *
 * Pure, and the sentence is a deliverable rather than a detail. A coding session is a `claude
 * --dangerously-skip-permissions` child process on somebody's laptop; the chat tools now start one
 * on their own initiative, so the reply that follows must name it. The closing instruction is
 * addressed to the model reading the tool result, which is the only place this module can reach —
 * the alternative (a line in the system prompt) is a different file and a different lane.
 *
 * It also carries the reap, because this is the exact moment the missing sentence was missing:
 * the user's previous session had been taken away six hours after they stopped touching it, the
 * timeline said so in the Co-pilot view they were not looking at, and from chat the session had
 * simply stopped existing.
 *
 * And since #408 it carries whether the engine picked the previous conversation back up. THREE
 * outcomes, not two, and collapsing them is the mistake this function exists to prevent:
 *
 *   1. asked to resume, machine CONFIRMED it   → "picked up where it left off"
 *   2. decided to start clean                  → "fresh, and here is why"
 *   3. asked to resume, no confirmation        → ALSO fresh. A runner published before #408 drops
 *      the field and starts clean, and both of the owner's machines run such a build today. A
 *      cloud that reported its own INTENT would tell most of the fleet the opposite of what
 *      happened, which is a worse bug than the silence #408 set out to fix — it would be a
 *      confident, wrong answer to "did you remember what we were doing?".
 */
export function sessionOpenedNotice(input: {
	repoName: string;
	sessionId: string;
	engine: string;
	node?: string | null;
	reapedPrevious?: boolean;
	idleHours?: number;
	/** What was decided about continuing the repo's previous conversation. */
	continuity?: SessionContinuity;
	/** What the machine confirmed it did. Absent/false means the engine started clean. */
	resumed?: boolean;
}): string {
	const where = input.node ? ` on ${input.node}` : "";
	const previous = input.reapedPrevious
		? ` The previous session for this repo had been closed automatically after ${input.idleHours ?? Math.round(IDLE_SESSION_MS / 3_600_000)} hours with no activity, which is why there was none to read.`
		: "";
	let continuity = "";
	if (input.resumed === true) {
		continuity = " It picked up this repo's previous conversation, so the earlier context is still there.";
	} else if (input.continuity?.mode === "resume") {
		// Case 3. Say what happened (clean) and why the intent did not land, without guessing which
		// of the two causes it was — both are true statements about the boundary.
		continuity =
			" It started a FRESH conversation: the previous one could not be continued on that machine" +
			" — a conversation only exists on the machine that held it, and a `pags up` older than this feature cannot resume at all.";
	} else if (input.continuity) {
		continuity = ` It started a fresh conversation — ${input.continuity.reason}.`;
	}
	return (
		`Started a coding session for ${input.repoName}${where} — the ${input.engine} Engine is running there now (session ${input.sessionId}).${previous}${continuity}` +
		" Say in your reply that you started it, and whether it kept the previous conversation:" +
		" a process just appeared on the user's machine, they did not ask for one, and what it does or does not remember changes what they should tell it next."
	);
}

export type ChatSessionResult =
	| { ok: true; session: CodingSessionRecord; opened: boolean; notice: string | null }
	| { ok: false; session: CodingSessionRecord | null; message: string };

/**
 * A live session for a chat tool that needs one — the missing half of #271.
 *
 * `ensureActiveSession` had exactly one caller, `loop-drivers.ts`, so the same agent in the same
 * conversation about the same repo could be told "go fix it" and silently spawn an engine, but
 * asking "what is the terminal showing?" got "No active session" and a instruction to go and press
 * a button. The path with the LARGER consequence was the one that self-served.
 *
 * Two things this adds over calling `ensureActiveSession` directly, and both are the reason it is a
 * function rather than a line at each call site:
 *
 *  1. CONNECTIVITY FIRST, from the same resolver delegation uses. Not politeness — correctness.
 *     With no runner, `ensureActiveSession` still INSERTS a `coding_sessions` row before it
 *     discovers there is nothing to launch on, then ends it. Harmless for a Loop that reports a
 *     409 either way; not harmless for a read tool a user may call repeatedly at an airport, and
 *     the refusal has to be the runner diagnosis, not a session failure. `noSessionMessage` is the
 *     shared wording so a chat refusal and the `subordinate_status` a supervisor reads cannot
 *     contradict each other — the failure mode that produced it in the first place.
 *  2. The notice. See `sessionOpenedNotice`.
 */
export async function ensureSessionForChat(
	env: Env,
	instanceId: string,
	userId: string,
	repo: CodingRepo,
): Promise<ChatSessionResult> {
	const facts = await runtimeConnectivity(env, instanceId, userId).catch(() => null);
	const connectivity = classifySubordinateConnectivity({
		// These tools only exist on an agent whose work runs on a local machine, so a runner is
		// required unconditionally — same reasoning as the coding driver.
		requiresRunner: true,
		// SPREAD, never enumerate (#468) — see `EMPTY_RUNTIME_FACTS`.
		...(facts ?? EMPTY_RUNTIME_FACTS),
	});
	if (!connectivity.canWork) {
		// No row is created on this path — that is the point of checking here. The existing session
		// is still looked up, because a caller with a saved snapshot to show should show it rather
		// than nothing.
		const existing = await getActiveSessionForRepo(env, instanceId, userId, repo.id).catch(() => null);
		return { ok: false, session: existing, message: noSessionMessage({ repoName: repo.name, connectivity }) };
	}

	const ensured = await ensureActiveSession(env, instanceId, userId, repo);
	if (!ensured.ok) {
		return {
			ok: false,
			session: ensured.session ?? null,
			message: noSessionMessage({ repoName: repo.name, connectivity, startError: ensured.startError }),
		};
	}
	if (!ensured.opened) return { ok: true, session: ensured.session, opened: false, notice: null };

	// Only on the open path: reusing a session answers "what happened to the last one" by not
	// raising the question, and this is an extra query.
	const reaped = await lastIdleReapForRepo(env, instanceId, userId, repo.id).catch(() => null);
	return {
		ok: true,
		session: ensured.session,
		opened: true,
		notice: sessionOpenedNotice({
			repoName: repo.name,
			sessionId: ensured.session.id,
			engine: ensured.session.clientType || "claude",
			node: connectivity.node,
			reapedPrevious: Boolean(reaped),
			idleHours: Math.round(IDLE_SESSION_MS / 3_600_000),
			continuity: ensured.continuity,
			resumed: ensured.resumed,
		}),
	};
}
