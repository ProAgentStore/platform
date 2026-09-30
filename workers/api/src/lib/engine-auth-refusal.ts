/**
 * A run refused before it started because its engine is not signed in (#891).
 *
 * The failure this closes: a Codex engine with no stored login was handed a run, and each turn
 * spent ~35s retrying a 401 against the provider before failing. The Pilot read three identical
 * failures and gave up with a vague "possibly a configuration issue". The missing login could be
 * seen before the first turn: the #879 preflight asks the machine, and a fresh session already
 * refused on it. A run on a REUSED session never asked (see `ensureActiveSession`).
 *
 * A refusal on its own would be a 409 sentence the owner reads once and loses. So the refused run is
 * RECORDED, already finished with `engine_auth`, the same stop reason a run that parked on a login
 * prompt and ran out of time gets. That gives it the same follow-up as one:
 *
 *   - `coding_diagnostics` reports `needsReauth`, since the latest run stopped on sign-in;
 *   - `coding_engine_reauth` lists it among the runs to continue once the sign-in lands;
 *   - `continue_instance_run` accepts it, because `engine_auth` is a resumable stop reason.
 *
 * `no-binary` is NOT recorded this way. Signing in does not install a CLI, and a stop reason that
 * sends the owner to `coding_engine_reauth` for a missing binary would send them the wrong way.
 */
import { createLoopRun, finishLoopRun } from "./agent-loop-store.js";
import type { Env } from "../types.js";

/** The run's recorded outcome: the preflight's own sentence, with what happens to the run next. */
export function engineAuthRefusalDetail(preflightMessage: string): string {
	return `Refused before the first turn: ${preflightMessage} Nothing ran and no iteration was spent. Once it is signed in, continue this run (continue_instance_run) or start it again.`;
}

/** Record the refused run as finished with `engine_auth`, and return its id. */
export async function recordEngineAuthRefusal(
	env: Env,
	input: {
		instanceId: string;
		userId: string;
		objective: string;
		maxIterations: number;
		budgetId: string;
		/** The session the run would have driven. `continue` reads its repo off it, so a multi-repo Coder continues on the right checkout. */
		sessionId: string;
		delegatedBy?: string | null;
		preflightMessage: string;
	},
): Promise<string> {
	const runId = crypto.randomUUID();
	const now = Date.now();
	await createLoopRun(env, {
		runId,
		userId: input.userId,
		instanceId: input.instanceId,
		objective: input.objective,
		maxIterations: input.maxIterations,
		budgetId: input.budgetId,
		startedAt: now,
		delegatedBy: input.delegatedBy ?? null,
		sessionId: input.sessionId,
	});
	await finishLoopRun(env, runId, "engine_auth", engineAuthRefusalDetail(input.preflightMessage), now);
	return runId;
}
