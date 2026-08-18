/**
 * (Re)launch a coding session's engine on whatever machine the run is talking to.
 *
 * `/coding/start` is idempotent, and this is called from TWO places for that reason: once at the
 * top of a run, and again by the runner guard every time a disconnect heals (#341). A runner that
 * dropped may have restarted, or the agent may be live on a different machine, and either way the
 * engine has to exist again before the loop can carry on.
 *
 * EXTRACTED from `workflows/coding-session.ts` (#553), which sits on an 800-line ratchet. It never
 * needed the Workflow — it needs the session's identity and the connection to send it down.
 */
import { callRunner, type RunnerConn } from "./runner-client.js";
import { getRepo, getSession } from "./coding-store.js";
import { resolveEngineEnv } from "./coding-engines.js";
import type { Env } from "../types.js";

export interface RelaunchInput {
	instanceId: string;
	userId: string;
	sessionId: string;
	repoId: string;
	/** The engine to spawn when the session has no recorded launch command. */
	clientType?: string;
	cloneUrl?: string;
	branch?: string;
	token?: string;
	tokenUsername?: string;
}

export async function startSessionOnRunnerConn(env: Env, conn: RunnerConn, input: RelaunchInput): Promise<{ sessionId?: string }> {
	const { instanceId, userId, sessionId, repoId } = input;
	// Resolve the session's exact CLI command, its workDir, and its engine env (API key / OAuth
	// token) FRESH here — the same fields `startSessionOnRunner` passes. Without them, a runner
	// that must re-create the session after a restart would relaunch the DEFAULT cli with NO auth
	// (wrong binary / auth failure). Env is resolved at call time and never journalled, so the key
	// does not land in workflow state — matching how the runner token is kept out of it elsewhere.
	const [sess, repo] = await Promise.all([getSession(env, instanceId, userId, sessionId), getRepo(env, instanceId, userId, repoId)]);
	const engineEnv = sess ? await resolveEngineEnv(env, instanceId, userId, sess) : undefined;
	return callRunner<{ sessionId?: string }>(conn, "/coding/start", {
		sessionId,
		repoId,
		workDir: repo?.workdir || undefined,
		cloneUrl: input.cloneUrl,
		branch: input.branch,
		token: input.token,
		tokenUsername: input.tokenUsername,
		clientType: input.clientType,
		command: sess?.launchCommand || undefined,
		// Resolved fresh here for the same reason the command and the env are (#679): a relaunch
		// that omitted the scope would silently restore an UNGUARDED engine after every runner
		// restart, which is exactly when nobody is looking.
		ghScope: repo?.githubRepo ? [repo.githubRepo] : undefined,
		env: engineEnv,
	});
}
