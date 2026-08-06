// Is the Engine doing something right now?
//
// The runner's vocabulary is `idle | thinking | responding`
// (packages/browser-runner/src/coding/runtime.ts), reported per session by
// `/coding/capture` as `runState`.
//
// Every consumer of that field had independently written
// `state === "thinking" || state === "working"` — which gets it wrong twice:
// `"working"` is not a state the runner can ever emit, and `"responding"` (the
// engine streaming its answer) fell through as NOT busy. So a session that was
// mid-answer showed "Idle" in the repo list, and — worse — `watchForFinish` and
// the coding Loop both treat not-busy as finished, so they could fire the
// completion summary / next instruction into an engine that was still talking.
//
// One predicate, one vocabulary. `"working"` stays accepted as a legacy alias
// so nothing regresses if an older runner or a persisted row still carries it.

/** States the runner reports; widened to `string` since it arrives over HTTP. */
export type EngineRunState = "idle" | "thinking" | "responding" | (string & {});

const BUSY: ReadonlySet<string> = new Set(["thinking", "responding", "working"]);

/** True while the engine is taking a turn — thinking OR streaming its answer. */
export function isEngineBusy(state: EngineRunState | null | undefined): boolean {
	return typeof state === "string" && BUSY.has(state);
}

/** True if ANY of the given sessions' states is busy. Accepts the `repoId → state` map directly. */
export function anyEngineBusy(states: Record<string, EngineRunState> | Iterable<EngineRunState> | null | undefined): boolean {
	if (!states) return false;
	const values = Symbol.iterator in Object(states)
		? (states as Iterable<EngineRunState>)
		: Object.values(states as Record<string, EngineRunState>);
	for (const s of values) if (isEngineBusy(s)) return true;
	return false;
}
