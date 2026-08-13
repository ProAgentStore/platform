// `end_coding_session` — the agent's own way to close the engine on the user's machine (#540).
//
// The SECOND object of one gap. The owner said "finish the session" and meant "stop what you are
// doing", but the two are genuinely different things with different lifecycles, and a fix that
// collapsed them would be wrong in both directions:
//
//   • An autonomous RUN (`agent_loop_runs`) is a Pilot loop with an objective, a budget and a
//     runId. `stop_work` stops that, cooperatively, and deliberately LEAVES the session open — the
//     session is a cache (#408) and its engine conversation is worth keeping.
//   • A coding SESSION (`coding_sessions`) is a child process on a machine, holding one repo's
//     working directory. Ending it kills that process. Nothing needs to be running for a session
//     to be open, which is exactly why "nothing is running" was not a complete answer to the
//     owner's question.
//
// Kept out of `tool-registry.ts` and imported on demand, like every other first-party tool that
// touches D1: that file is imported by the connector registry and by `agent-do-tools`, and pulling
// the coding store into its import graph is the cycle the deferred imports there exist to avoid.
import { listLoopRuns, requestCancel } from "./agent-loop-store.js";
import { endCodingSession } from "./coding-session-end.js";
import { listRepos, listSessions } from "./coding-store.js";
import type { RegistryToolResult } from "./connectors/types.js";
import type { Env } from "../types.js";

/**
 * Which session a bare "end the session" means.
 *
 * Pure, and it refuses to guess. With several sessions open and no repo named, ending "the" session
 * would pick one of the user's repositories at random and kill the engine holding it — the same
 * class of mistake `pickLoopRepo` refuses to make in `loop-drivers.ts`, and for the same reason:
 * the wrong choice is not recoverable by asking again afterwards. Asking which one is a real answer;
 * silently ending the wrong one is not.
 */
export function pickSessionToEnd<T extends { id: string; repoId: string }>(
	sessions: readonly T[],
	repoNameById: ReadonlyMap<string, string>,
	repo?: string,
): { ok: true; session: T } | { ok: false; content: string } {
	if (!sessions.length) {
		return {
			ok: false,
			content:
				"There is no coding session open on this agent, so there was nothing to end. Say that plainly — do not tell" +
				" the user you ended a session. (If they meant a run in progress, stop_work is the tool for that.)",
		};
	}
	const named = (s: T) => repoNameById.get(s.repoId) ?? s.repoId;
	if (repo) {
		const want = repo.trim().toLowerCase();
		const found = sessions.find((s) => named(s).toLowerCase() === want || s.repoId === repo || s.id === repo);
		return found
			? { ok: true, session: found }
			: {
					ok: false,
					content: `No open coding session for "${repo}". Open sessions: ${sessions.map(named).join(", ")}. Ask which one they mean rather than picking.`,
				};
	}
	if (sessions.length > 1) {
		return {
			ok: false,
			content:
				`There are ${sessions.length} coding sessions open — ${sessions.map(named).join(", ")}. Ask which repository's` +
				" session to end and call this again with `repo`. Do not pick one yourself: ending the wrong session kills the" +
				" engine working on that repository.",
		};
	}
	return { ok: true, session: sessions[0] };
}

export async function endAgentCodingSession(
	env: Env,
	instanceId: string,
	userId: string,
	repo?: string,
): Promise<RegistryToolResult> {
	const [sessions, repos] = await Promise.all([
		listSessions(env, instanceId, userId),
		listRepos(env, instanceId, userId).catch(() => [] as Array<{ id: string; name: string }>),
	]);
	const open = sessions.filter((s) => s.status === "active" || s.status === "suspended");
	const picked = pickSessionToEnd(open, new Map(repos.map((r) => [r.id, r.name])), repo);
	// Not an error: "there is no session" and "which of the three?" are both complete answers, and a
	// failed tool result reads to the model as "could not tell" — the state that produces a guess.
	if (!picked.ok) return { content: picked.content, success: true };
	const session = picked.session;
	const repoName = repos.find((r) => r.id === session.repoId)?.name ?? session.repoId;

	// A run driving this session is asked to stop FIRST, and it is the same cooperative request
	// `stop_work` makes. Ending the session alone would already stop the Pilot — `pilotStopSignal`
	// treats an `ended` session as a stop — but it would stop it with no reason recorded, so the run
	// would read afterwards as having simply died. With the flag set, `pilotStopSignal` prefers the
	// cancel and the run records "Stopped by you.", which is the true sentence.
	const driving = (await listLoopRuns(env, userId, instanceId, 20).catch(() => []))
		.filter((r) => r.status === "running" && r.sessionId === session.id);
	for (const run of driving) await requestCancel(env, userId, run.runId).catch(() => undefined);

	const ended = await endCodingSession(env, { instanceId, userId, sessionId: session.id });
	if (!ended.ok) {
		// The row did not move, so the session was already closed by something else between the read
		// and the write. Reporting "ended" here would be a claim about an act that did not happen.
		return {
			content: `The ${repoName} session was already closed before this — nothing was ended. Do not claim you ended it.`,
			success: true,
		};
	}
	const runClause = driving.length
		? ` The run that was driving it (${driving.map((r) => r.runId).join(", ")}) has been asked to stop; it finishes the step it is on first, so say you have asked it to stop rather than that it has stopped.`
		: "";
	// `engineStopped` is three-valued on purpose and each value gets its own sentence. "The machine
	// is not connected" is NOT "the engine stopped": it is the state in which nobody can say.
	const engineClause =
		ended.engineStopped === false
			? ` ${ended.warning}`
			: ended.engineStopped === null
				? " The machine running it is not connected, so the engine could not be told to stop — the session is closed here, and if that machine comes back the process may still be running."
				: " The engine on the machine confirmed it stopped.";
	return { content: `Ended the coding session for ${repoName}.${engineClause}${runClause}`, success: true };
}
