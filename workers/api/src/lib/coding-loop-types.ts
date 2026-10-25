/**
 * The coding loop's shared types — the goal, the pane snapshot, an action, a decision, a cap summary (#1359).
 *
 * A leaf, so `coding-loop.ts` (the loop) and `coding-pilot.ts` (the brain it drives) can both name them without
 * importing each other. `coding-loop.ts` re-exports every one, so existing importers are unchanged.
 */
import type { AskNeedsInput } from "./coding-ask.js";
import type { EngineInputs } from "./coding-engine-inputs.js";
import type { ObjectiveOrigin } from "./coding-objective-origin.js";
import type { PilotModelId } from "./pilot-model.js";
import type { PilotInferenceReply } from "./pilot-routing.js";
import type { MergePolicy } from "./coding-authority.js";
import type { EngineTurnReport } from "./coding-turn-outcome.js";
import type { ScopeConstraint } from "./coding-scope-constraints.js";

export interface CodingGoal {
	/** Explicit controller canary; separate from advisory Brain and the local coding engine. */
	pilotModel?: PilotModelId;
	/** What the user wants done in this repo (the high-level task). */
	objective: string;
	/** Who the platform verified wrote `objective` (#1019) — what the engine is told. Absent: unverified. */
	objectiveOrigin?: ObjectiveOrigin;
	/** Repo display name / path, for context. */
	repo: string;
	clientType: "claude" | "gemini" | "codex" | "grok";
	/** Rules injected at top of prompt: the platform's repo-state notes, and a caller's own (`/run`). */
	specialInstructions?: string;
	/** The OWNER's standing rules (instance + repo), re-read before every decision (#1015). */
	standingInstructions?: string;
	/** What the owner sent this session during the run, oldest first, re-read every decision (#1015). */
	ownerDirectives?: Array<{ text: string; at: number; delivery: string; processed: boolean }>;
	/** What those rules and EVERY directive of the run still require, derived per decision and enforced on each action (#1019). */
	scopeConstraints?: ScopeConstraint[];
	/** Live free-text message the user sent while the agent was paused/stuck. */
	userHint?: string;
	/**
	 * How many times the OWNER has intervened in this run so far (#505).
	 *
	 * The difference from {@link userHint} is durability. `userHint` is one round's message and is
	 * overwritten on the next resume — often with `undefined`, because a resolved captcha is an owner
	 * turn that carries no words. So a run where the human answered a takeover in round 1 and the
	 * Pilot claimed their authority in round 3 was told "no message from the owner has reached you",
	 * which is true of that round and false of the run. The counter is the run-scoped fact, and it is
	 * the same one `annotateOwnerAttribution` already reads on the report side — so the instruction
	 * stamp and the completion stamp can no longer disagree about whether a human spoke.
	 *
	 * Written by `workflows/coding-session.ts` beside `userHint`; absent means none, which is the
	 * pre-existing behaviour for any caller that does not set it.
	 */
	ownerTurns?: number;
	/**
	 * A fact the PLATFORM is telling the brain at the start of this round (#541).
	 *
	 * Deliberately not `userHint`, which renders as "The user just told you:" — attributing a
	 * platform action to the human is exactly what #505 stamps reports for. Two writers, both in
	 * `workflows/coding-session.ts`: at the START of a run, what a cut-off predecessor on this repo
	 * already landed (`pendingCodingResumeNote`, #523/#806), and after a usage-limit park, that the
	 * window has reset (`engineResumeNote`). One round reads it and the workflow then clears it.
	 */
	resumeNote?: string;
	/**
	 * The owner's IANA zone, resolved once per run, for the clock the brain converts against (#541).
	 *
	 * Undefined is the honest unset state and renders as UTC, out loud — `accountTimeZone` returns
	 * undefined on any failure and a silently-assumed zone is a ten-hour error.
	 */
	timeZone?: string;
	/** Test mode: plan + send guidance but NEVER let a destructive action through. */
	dryRun?: boolean;
	/**
	 * A REPAIR run (#804): its only objective is to bring the checkout back in sync. The workflow
	 * lets it through the sync gate and REPLACES `objective` with the platform's brief
	 * (`repairCheckoutObjective`); the owner's words ride along as a note. Absent = a normal run.
	 */
	repairCheckout?: boolean;
	/**
	 * What this run may do with the repo's trunk (#314). Resolved once by the workflow from the
	 * repo override / agent setting / platform default — see lib/coding-authority.ts. Absent behaves
	 * as `merge`, which is the pre-existing behaviour.
	 */
	mergePolicy?: MergePolicy;
}

/** What the orchestrator "sees": the current pane plus the CLI's run-state. */
export interface CodingPaneSnapshot {
	pane: string;
	/** The session's output length before the runner's 64 KiB cut (#898); absent from older runners. */
	paneChars?: number;
	runState: "idle" | "thinking" | "responding";
	ready: boolean;
	alive: boolean;
	/** True when the user pressed Stop — the loop halts immediately. */
	cancelled?: boolean;
	/**
	 * How the Engine's LAST COMPLETED TURN ended (#545), straight from the runner.
	 *
	 * Beside `alive`/`runState`, never instead of them: this session can still take a turn and is
	 * not taking one right now even when the last turn exited 1 — both were true in the production
	 * capture, and both would still be true if the platform reported them honestly today. What was
	 * missing is this field, so `runCodingLoop`'s two liveness guards correctly did not fire and
	 * the brain was left to work an exit code out of the pane's prose.
	 *
	 * Optional because a runner older than CLI `TURN_REPORT_MIN_CLI` (coding-turn-outcome.ts) does
	 * not send it, and absent must read as "not measured" — see `classifyTurn`.
	 */
	lastTurn?: EngineTurnReport;
	/**
	 * Ids of inputs (owner directives) a COMPLETED engine turn consumed, from the runner (#1019). Absent on a
	 * runner that predates it — and absent is "not known", never "consumed". See `markDirectivesProcessed`.
	 */
	consumedInputs?: string[];
	/** Ids the runner accepted (handed to the engine), on a `coding.input-idempotent` runner (#1019). Absent: an older runner. */
	acceptedInputs?: string[];
	/** Which input ledger and engine process answered, and whether this act's id was a same-content duplicate or a conflict (#1019). */
	engine?: EngineInputs;
	duplicateInput?: string;
	inputConflict?: string;
	/**
	 * Why the run was stopped, when it was stopped by something other than the user's Stop button.
	 *
	 * Without it every halt reported the bare outcome "cancelled", which is indistinguishable from
	 * a human pressing Stop — so a run halted for merging against policy (#314) would look like the
	 * owner had changed their mind.
	 */
	stopReason?: string;
}

/**
 * What the cloud can ask a coding session to do.
 *
 * `{kind:"keys"}` was removed in #448. It had no producer left — the brain stopped offering
 * `press_keys` (see `CODING_TOOLS` below) and `/message` now refuses `{keys}` with a 409 — but
 * while the kind stayed in this union the mapping back into it was one line away from being
 * re-added, which is exactly how it survived the first fix. The engine is a child process with
 * no PTY; there is no keystroke to send, and the type now says so.
 */
export type CodingActionKind = { kind: "message"; text: string; author?: "pilot"; inputId?: string; objective?: { runId: string; text: string; origin: ObjectiveOrigin; constraints?: string[] } } | { kind: "interrupt" };

/**
 * `waiting` is the only NON-TERMINAL member (#541): the Engine cannot work right now for a reason
 * that resolves on a clock rather than by anyone doing anything. The loop returns it, the workflow
 * parks and re-enters — and only when the run's wait budget is spent does it stay as the outcome,
 * which is why it must never be treated as a failure by the surfaces that read one.
 *
 * `needs_reauth` (#881) is the Engine blocked on its OWN sign-in — "Not logged in · Please run
 * /login". It used to end as `failed` ("coding session is not running") or as a Pilot `stuck`,
 * both of which read like a crash. Its remedy is one specific owner act — sign the engine in, which
 * the re-auth relay lets them do from any device — so it is its own outcome, and the workflow parks
 * on it waiting for that relay to report success.
 */
export type CodingOutcome = "done" | "stuck" | "needs_input" | "failed" | "max_steps" | "cancelled" | "waiting" | "needs_reauth" | "engine_error";

export interface CodingDecision {
	pilotRouting?: PilotInferenceReply["pilotRouting"];
	thought?: string;
	action?: CodingActionKind;
	/** What the Pilot wants to still know at its next decision (#822) — see {@link LEARNED_MAX}. */
	learned?: string;
	finish?: { status: "done" | "failed"; detail: string };
	/** The orchestrator can't proceed without a human (stuck handoff). */
	stuck?: { why: string };
	/** The run was cancelled while the decision was being recovered (#907) — end as cancelled, send nothing. */
	cancelled?: { why: string };
	/**
	 * Something only the owner can supply (ask-and-hold): a VALUE (`request_user_info`), or a CHOICE
	 * between options (`ask_owner`, #960) — in which case `field` is the question itself and
	 * `options` the answers offered. Both are answered from a conversation, not by taking over.
	 */
	needsInput?: AskNeedsInput;
	/**
	 * The Engine reported ITS OWN usage/rate limit (#541). `at` is the reset instant it named, as an
	 * ISO-8601 string that must carry an explicit offset to be believed — see `coding-wait.ts`.
	 */
	waitUntil?: { at?: string; why: string };
	usage?: { input: number; output: number };
	/**
	 * The provider stopped this decision at its output cap (#504).
	 *
	 * `stopReason` reached this path with #397 and was thrown away here — its only reader was the
	 * chat path — so "the brain was cut off mid-instruction" and "the brain said nothing" arrived
	 * looking identical. They call for different words to the owner and different next steps, so
	 * the fact is carried rather than re-inferred from the shape of an empty reply.
	 */
	truncated?: boolean;
	/** On the one extra, cap-only decision (#1261) — see {@link CapSummary}. */
	capSummary?: CapSummary;
}

/**
 * What the brain reports when it runs out of steps without finishing (#1261), in place of a bare
 * "gave up after N steps": what it DID in concrete terms, the EXACT blocker (never summarized or
 * cut downstream), whatever plan it has for continuing — or that it has none — and how many more
 * steps it wants and why. The owner was being asked to approve a fixed number nobody had
 * justified; this is the brain's own case for the number, not the platform's guess.
 */
export interface CapSummary {
	/** Concrete actions taken in the capped steps: files changed, commands run, commits (cite SHAs). */
	did: string;
	/** The exact blocker, as the brain stated it — carried verbatim, never clipped further downstream. */
	blocker: string;
	/** A concrete plan for the next steps. Empty when the brain said plainly that it has none. */
	plan: string;
	/** How many more steps it is asking for. */
	steps: number;
	/** Why that many. */
	reason: string;
}
