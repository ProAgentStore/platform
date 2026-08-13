/**
 * How the LAST completed engine turn ended (#545).
 *
 * The exit code was already known on this side and spent entirely on prose: `runOneShot`'s close
 * handler pushed `[codex exited with code 1]` into the transcript and set no field, so a production
 * Codex session whose every turn exited 1 — three times, the reason printed each time — reported
 * `alive: true, ready: true, runState: "idle"`, and the Pilot spent fifteen minutes and three BYOK
 * decisions rediscovering it from the pane.
 *
 * OUTCOME AND LIVENESS ARE TWO FACTS, and this module owns only the first. Nothing here touches
 * `alive`: a one-shot session has no process between turns, a failing turn does not make the
 * session unable to take another, and conflating the two once killed every delegated goal on
 * codex/grok/gemini at iteration 0 (see `HeadlessSession.alive`). The failure is REPORTED here;
 * what to make of one is the cloud's judgement, in `workers/api/src/lib/coding-turn-outcome.ts`.
 *
 * Its own module, beside `engine-usage.ts` / `engine-acts.ts` / `engine-auth.ts`, for the reason
 * they are: the RULE that turns a process exit into a verdict is worth testing without spawning a
 * process, and it is the part someone will later be tempted to change.
 */

/** Longest engine line carried as {@link EngineTurnReport.detail}. The pane holds the rest. */
export const MAX_TURN_DETAIL = 240;

/**
 * Each engine mechanism reports only what it can honestly know:
 *   * a RAW one-shot engine's turn IS a process, so its exit code is the turn's own verdict;
 *   * Claude's stream-json turn ends with a `result` event carrying `is_error`, which is the same
 *     statement in the protocol's own words — no exit code exists, so `exitCode` stays null.
 *
 * Absent means NOT MEASURED — no turn has completed on this session, or the runner predates the
 * field (CLI < 0.4.51). It never means "fine".
 */
export interface EngineTurnReport {
	/**
	 * `ok` — the engine said the turn succeeded (exit 0 / a `result` with no error).
	 * `failed` — the engine itself reported failure (non-zero exit / `is_error`).
	 * `killed` — WE ended it (a new instruction pre-empting the turn, the wedge ceiling, an
	 *   interrupt). That is evidence about this platform's timers, not about the engine's health,
	 *   so it is neither a success nor a failure and the cloud counts it as neither.
	 */
	verdict: "ok" | "failed" | "killed";
	/** The process's own exit code. Null for stream-json (no process per turn) and for a signal kill. */
	exitCode: number | null;
	/** The signal that terminated the process, when one did. */
	signal: string | null;
	/** When the turn ended (epoch ms). The turn's IDENTITY for a cloud poll that sees it repeatedly. */
	at: number;
	/**
	 * The engine's own last line, verbatim and capped.
	 *
	 * Captured as it was written rather than scraped back out of the pane: the whole point of #545
	 * is that a regex over an engine's prose is the class of guess #391 removed from `runState`.
	 */
	detail?: string;
}

/**
 * A one-shot turn's process has exited — say what that means, and nothing more.
 *
 * A SIGNAL outranks the code because a signalled process's code is null and the kill is ours: the
 * 15-minute wedge ceiling and `interrupt()` both land here, and counting either as an engine
 * failure would let three slow builds read as a broken CLI.
 */
export function turnReportFromExit(code: number | null, signal: string | null, lastLine = "", now = Date.now()): EngineTurnReport {
	const detail = lastLine.trim().slice(0, MAX_TURN_DETAIL);
	return {
		verdict: signal !== null ? "killed" : code === 0 ? "ok" : "failed",
		exitCode: code,
		signal,
		at: now,
		...(detail ? { detail } : {}),
	};
}

/**
 * A stream-json turn ended with a `result` event — the structured path's analogue of an exit code.
 *
 * Without it the field would exist for three engines and silently not for the flagship, which is
 * the shape of gap that makes a platform-wide claim ("we notice a failed turn") false in the one
 * case that runs most.
 */
export function turnReportFromResult(isError: boolean, detail = "", now = Date.now()): EngineTurnReport {
	const text = detail.trim().slice(0, MAX_TURN_DETAIL);
	return {
		verdict: isError ? "failed" : "ok",
		exitCode: null,
		signal: null,
		at: now,
		...(text ? { detail: text } : {}),
	};
}
