export interface RunnerCodingLifecycle {
	sessionId?: unknown;
	alive?: unknown;
	runState?: unknown;
}

export interface RunnerWorkObservation {
	sessions?: unknown;
	work?: { codingTurns?: unknown; localRuns?: unknown; detail?: unknown };
}

/**
 * Turn the two runner observations into the named work that blocks a restart (#1007).
 *
 * A retained engine is safe only when its own lifecycle says `alive:true, runState:"idle"`.
 * Every missing or unrecognised value is deliberately a named blocker: an observation problem is
 * never evidence that it is safe to cut off an owner's machine. The session id and state are
 * diagnostic metadata only; no terminal text, paths, credentials, or prompts pass this boundary.
 */
export function observedRunnerWork(observation: RunnerWorkObservation): string[] {
	const sessions = observation.sessions;
	const work = observation.work;
	if (!Array.isArray(sessions) || !work || typeof work !== "object") return ["runner-work-observation-unavailable"];
	const codingTurns = typeof work.codingTurns === "number" && Number.isInteger(work.codingTurns) && work.codingTurns >= 0 ? work.codingTurns : null;
	const localRuns = typeof work.localRuns === "number" && Number.isInteger(work.localRuns) && work.localRuns >= 0 ? work.localRuns : null;
	const detail = Array.isArray(work.detail) && work.detail.every((item) => typeof item === "string") ? work.detail : null;
	if (codingTurns === null || localRuns === null || detail === null) return ["runner-work-observation-unavailable"];

	const activeCoding = (sessions as RunnerCodingLifecycle[]).flatMap((session) => {
		// A definitely stopped process cannot be interrupted. Everything else must prove it is idle.
		if (session?.alive === false) return [];
		const id = typeof session?.sessionId === "string" && session.sessionId ? session.sessionId : "unidentified-session";
		const state = typeof session?.runState === "string" && session.runState ? session.runState : "unknown";
		if (session?.alive === true && state === "idle") return [];
		return [`coding session ${id} (${state})`];
	});
	const unmatchedCodingTurns = Math.max(0, codingTurns - activeCoding.length);
	const localDetail = detail.slice(codingTurns);
	return [
		...activeCoding,
		...Array.from({ length: unmatchedCodingTurns }, (_v, i) => `coding-turn-unmatched-${i + 1}`),
		...Array.from({ length: localRuns }, (_v, i) => localDetail[i] || `local-run-${i + 1}`),
	];
}
