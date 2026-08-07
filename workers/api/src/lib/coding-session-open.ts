// Getting a repo to a LIVE coding session — the one place that knows how (#271).
//
// `startSessionOnRunner` used to be a private helper inside `routes/coding.ts`, reachable only by
// someone typing in the console. That is why delegation could not open a session for itself and
// had to 409 instead: the capability existed, it was just behind a route. Moved here verbatim so
// the autonomous path (`loop-drivers.ts`) and the interactive path share ONE implementation —
// a second copy would drift on exactly the details that make it work (machine-switch reclaim,
// installation tokens, engine env).
import { callRunner, getBoundRunnerConn, getRunnerConn, relayConnected, type RunnerConn } from "./runner-client.js";
import { installationTokenForOwner } from "./github-app.js";
import { resolveEngine, resolveEngineEnv } from "./coding-engines.js";
import { createSession, endSession, getActiveSessionForRepo, getRepo, reassignSessionNode, updateRepoClone } from "./coding-store.js";
import { normalizeRunnerNode } from "./runtime-nodes.js";
import type { CodingRepo, CodingSessionRecord } from "./coding-types.js";
import type { Env } from "../types.js";

/**
 * Ensure a session is live on the user's runner: clone the repo (idempotent on
 * the runner) and launch the CLI. Returns the connection it actually used (null if
 * no runner is connected). Used both when creating a session and when re-attaching
 * an orphaned one (created while the runner was offline, or after a runner restart).
 *
 * IMPORTANT: on a machine switch this RELOCATES the session to the live machine and
 * returns THAT machine's connection — callers retrying a command must use the returned
 * conn, not one they captured earlier (which may point at the now-dead old machine).
 */
export async function startSessionOnRunner(
	env: Env,
	instanceId: string,
	uid: string,
	session: CodingSessionRecord,
	repo: CodingRepo,
): Promise<RunnerConn | null> {
	let conn = await getRunnerConn(env, instanceId, uid, session.runnerNode ?? null);
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
	if (!conn) return null;
	const owner = repo.githubRepo ? repo.githubRepo.split("/")[0] : "";
	const token = owner ? await installationTokenForOwner(env, uid, owner) : null;
	const engineEnv = await resolveEngineEnv(env, instanceId, uid, session);
	try {
		await callRunner(conn, "/coding/start", {
			sessionId: session.id,
			repoId: repo.id,
			// Local checkout → run in that dir (no clone). Else clone to a managed dir.
			workDir: repo.workdir || undefined,
			cloneUrl: repo.cloneUrl,
			branch: repo.branch || undefined,
			token: token ?? undefined,
			clientType: session.clientType,
			// The exact CLI command for this session's engine (Claude default, or a
			// user-configured Codex/Grok/custom). The runner spawns it.
			command: session.launchCommand || undefined,
			env: engineEnv,
		});
		await updateRepoClone(env, repo.id, { cloneStatus: "ready", cloneError: null });
		return conn;
	} catch (e) {
		const msg = e instanceof Error ? e.message.slice(0, 300) : String(e);
		await updateRepoClone(env, repo.id, { cloneStatus: "error", cloneError: msg });
		return null;
	}
}

export type EnsureSessionResult =
	| { ok: true; session: CodingSessionRecord; opened: boolean }
	| { ok: false; startError: string | null };

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
		if (await startSessionOnRunner(env, instanceId, userId, s, repo).catch(() => null)) return { ok: true, session: s, opened: false };
		const fresh = await getRepo(env, instanceId, userId, repo.id).catch(() => null);
		return { ok: false, startError: fresh?.cloneError ?? null };
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

	const started = await startSessionOnRunner(env, instanceId, userId, session, repo);
	if (!started) {
		// A session row whose engine never launched is worse than none: `getActiveSessionForRepo`
		// would hand it to every later attempt, so the repo would be permanently stuck behind a
		// session that cannot do anything. Close it and report the real reason.
		await endSession(env, instanceId, userId, session.id, "error").catch(() => undefined);
		// `startSessionOnRunner` records WHY on the repo (clone failure, bad engine command) and
		// then returns a bare null. Re-read it so the caller can say what actually went wrong
		// instead of the generic "no session" that sent a user chasing `pags up`.
		const fresh = await getRepo(env, instanceId, userId, repo.id).catch(() => null);
		return { ok: false, startError: fresh?.cloneError ?? null };
	}
	return { ok: true, session, opened: true };
}
