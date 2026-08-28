// ONE vocabulary for "what is the engine doing", over one probe (#593).
//
// ── The split this holds
//
// Two things answer that question and they are not the same kind of fact:
//
//   * what the ENGINE reported — `idle | thinking | responding`, the runner's own union
//     (`packages/browser-runner/src/coding/runtime.ts`, `CodingSnapshot.runState`). These are the
//     only values that come from looking at an engine.
//   * what the PLATFORM observed instead — the session is over, the machine is gone, or the probe
//     went unanswered. Nobody looked at an engine on any of these paths.
//
// Collapsing the second group into `idle` is the defect. `routes/coding.ts` returned `idle` on
// THREE paths — engine idle, no runner connection, runner never answered — and disambiguated only
// through the `runnerConnected`/`alive`/`ready` siblings, which the MCP projection then dropped. So
// "the engine is idle", "the machine is gone" and "the probe failed" arrived as one answer.
//
// `routes/coding-feed.ts` had already worked this out and said so in a comment ("`unknown` is a
// real answer and is not collapsed into `idle` … Collapsing it would be the same defect #580 is
// about — a dead thing reported as a benign state"). Two surfaces over one probe with two
// vocabularies, and the one MCP published was the older one. This is that comment, made executable
// and shared, so the next surface over this probe cannot invent a third.
//
// ── `working` and `offline` were never the engine's words
//
// The description on `coding_session_capture` advertised `idle/working/offline`. `working` is not
// a member of the runner's union and never has been — `agents/coder/web/src/engine-busy.ts` says
// so in its own header, having been written for consumers that tested for it — and `offline` is
// manufactured HERE, by the platform, never by an engine. An advertised value the code cannot emit
// is unfalsifiable by a reader and is what `state-vocabulary.test.ts` now measures across the
// whole tool surface.
//
// PURE — no D1, no Env, no fetch. The routes bring the three observations; this decides the word.

/** The engine's own union, and the ONLY values that come from an engine. Mirrors `CodingSnapshot.runState`. */
export const ENGINE_RUN_STATES = ["idle", "thinking", "responding"] as const;

/**
 * What the PLATFORM reports when no engine was reached.
 *
 * `ended` — the session is over; there is no engine to ask, and the pane died with it (#527).
 * `offline` — no runner connection, so the machine holding the engine is unreachable.
 * `unknown` — the runner IS connected and did not answer the probe. Nobody knows, and saying so is
 *   the whole point: this is the one that used to read `idle`.
 */
export const PROBE_RUN_STATES = ["ended", "offline", "unknown"] as const;

/** Every value any coding surface may publish for `runState`. */
export const CODING_RUN_STATES = [...ENGINE_RUN_STATES, ...PROBE_RUN_STATES] as const;

export type EngineRunState = (typeof ENGINE_RUN_STATES)[number];
export type CodingRunState = (typeof CODING_RUN_STATES)[number];

const ENGINE_SET: ReadonlySet<string> = new Set(ENGINE_RUN_STATES);

/** True for a value the runner itself could have reported. */
export function isEngineRunState(value: unknown): value is EngineRunState {
	return typeof value === "string" && ENGINE_SET.has(value);
}

/** The three observations any caller of `/coding/capture` has in hand. */
export interface RunStateProbe {
	/** Is the session still `active` in D1? */
	sessionActive: boolean;
	/** Did we resolve a live runner connection for it? */
	runnerConnected: boolean;
	/** What the snapshot reported, or null/undefined when there was no snapshot. */
	engineRunState?: unknown;
}

/**
 * The one mapping from a capture probe to a published `runState`.
 *
 * Ordered by what is KNOWN, most certain first: a session that is over cannot have a live engine
 * whatever a stale snapshot says, and an unreachable machine cannot report one either. An
 * unrecognised value from the runner is `unknown` rather than passed through, so a future runner
 * word cannot silently widen this vocabulary without the guard noticing.
 */
export function resolveRunState(probe: RunStateProbe): CodingRunState {
	if (!probe.sessionActive) return "ended";
	if (!probe.runnerConnected) return "offline";
	return isEngineRunState(probe.engineRunState) ? probe.engineRunState : "unknown";
}

/** The run behind a session, reduced to what "is it actually working?" needs. */
export interface SessionRunPark {
	status: string;
	/** `engine_limit` | `human` | `platform_interrupt` | "" — see `RunWaitReason`. */
	waitingReason: string;
	detail: string;
}

/** An issue in the shape `coding_diagnostics` reports. */
export interface CodingIssue {
	severity: "error" | "warn" | "info";
	message: string;
	fix?: string;
}

/** What each park reason means for someone trying to get work moving again. */
const PARK_GLOSS: Record<string, { what: string; fix: string; severity: "warn" | "info" }> = {
	engine_limit: {
		what: "the engine reported its OWN usage limit and is refusing work",
		fix: "Wait for the engine's limit to reset, or switch the session to another CLI engine (⚙ CLI engines)",
		severity: "warn",
	},
	human: {
		what: "the run is parked waiting for a person",
		fix: "Answer the handoff on the board, then the run continues",
		severity: "warn",
	},
	platform_interrupt: {
		what: "the run was interrupted — a platform deploy, or the AI provider dropping the connection — and is being resumed",
		fix: "Nothing to do — it resumes itself",
		severity: "info",
	},
};

/**
 * An engine that is UP but not working (#593).
 *
 * `coding_diagnostics` scored a session `healthy` with `issueCount: 0` while its pane ended
 * "You've hit your weekly limit · resets Aug 17 at 4pm" and "[error]". Every rule in that route
 * fires on a runner or relay fault, so the one failure mode where the machine is fine and the WORK
 * is stopped was the one thing the tool named for stuck sessions could not see.
 *
 * The verdict comes from the RUN, not from the pane. The run already records this — `engine_limit`
 * is a first-class `waitingReason` (#541) — so reading it is an observation, whereas grepping a
 * terminal buffer for "limit" would be a guess about free text written by whichever CLI the user
 * chose. `alive` is taken only to phrase the message: "up but refusing" is the sentence, and
 * `alive:false` is already reported as "dead: tracked but CLI process exited".
 *
 * Returns null when there is nothing to say — no run, or a run that is genuinely working.
 */
export function refusingEngineIssue(input: {
	sessionLabel: string;
	alive: boolean;
	run: SessionRunPark | null | undefined;
}): CodingIssue | null {
	const run = input.run;
	if (!run) return null;
	const parked = run.waitingReason ? PARK_GLOSS[run.waitingReason] : undefined;
	// A park with a reason nothing recognises is still a park, and is still not work.
	const isParked = !!run.waitingReason || run.status === "needs_human";
	if (!isParked) return null;
	const what = parked?.what ?? (run.waitingReason ? `the run is parked (${run.waitingReason})` : "the run is parked waiting for a person");
	const where = input.alive ? "the engine is up but not working" : "the engine is not running";
	const why = run.detail.trim() ? ` — ${run.detail.trim()}` : "";
	return {
		severity: parked?.severity ?? "warn",
		message: `Session ${input.sessionLabel}: ${where} — ${what}${why}`,
		fix: parked?.fix ?? "Answer the handoff on the board, then the run continues",
	};
}
