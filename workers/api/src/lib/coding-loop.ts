import { askOwnerDecision, type AskNeedsInput, type AskPart } from "./coding-ask.js";
import type { EngineInputs } from "./coding-engine-inputs.js";
import type { ObjectiveOrigin } from "./coding-objective-origin.js";
import { systemPromptSections, systemPromptText, type StreamDeadlines, type SystemPromptBlock } from "./user-ai.js";
import { DEFAULT_PILOT_MODEL, type PilotModelId } from "./pilot-model.js";
import { routinePilotReply, runPilotInference, type PilotInferenceReply } from "./pilot-routing.js";
import { hitOutputCap } from "./reply-truncation.js";
import { authorityInstruction, screenInstruction, type MergePolicy } from "./coding-authority.js";
import {
	instructionKey,
	readTargets,
	renderPaneForPilot,
	repeatCaution,
	repeatNote,
	repeatStopDetail,
	repetitionVerdict,
	rereadNote,
	rereads,
	PILOT_PANE_CHARS,
} from "./coding-repetition.js";
import { clockLine } from "./coding-wait.js";
import { engineSignInBlock, type EngineAuthPrompt } from "./engine-auth-prompt.js";
import { deadSessionDetail } from "./coding-dead-session.js";
import { instructionAttributionNote } from "./run-attribution.js";
import {
	EMPTY_STREAK,
	type EngineTurnReport,
	engineErrorEnding,
	engineFailureNote,
	MAX_ENGINE_FAILURES,
	observeTurn,
	type TurnStreak,
} from "./coding-turn-outcome.js";
import type { UsageContext } from "./usage.js";
import type { Env } from "../types.js";
import { ownerDirectivesBlock } from "./coding-owner-directives.js";
import { activeConstraints, constraintSources, constraintsBlock, type ScopeConstraint, scopeRefusalNote, screenScopedInstruction } from "./coding-scope-constraints.js";
import { CompletionEvidence, evidenceNote, finishRefusalNote, judgeCompletion } from "./coding-completion-evidence.js";
import { describeWriteRefusal } from "./write-scope-refusals.js";

/**
 * The coding orchestrator's brain loop.
 *
 * The local coding CLI (Claude Code / Gemini / …) is itself an agent running in
 * a tmux pane; this loop is the *orchestrator* over it (AgentCoder's "Option B"):
 * look at the pane, decide the single next instruction to send (or that the goal
 * is met / a human is needed), send it, wait for idle, repeat. Pure orchestration
 * over {@link CodingDeps} so it unit-tests without tmux, an LLM, or a Workflow —
 * exactly like {@link runApplyLoop} for the browser runtime.
 */

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

export interface CodingResult {
	outcome: CodingOutcome;
	detail?: string;
	fieldNeeded?: string;
	/** On `needs_input` from `ask_owner` (#960): the answers offered. Empty/absent for a free-form value. */
	options?: string[];
	/** On `needs_input` from `ask_owner` (#1129): the question uncut, when `fieldNeeded` had to be cut. */
	fullQuestion?: string;
	/** On `needs_input` from `ask_owner` (#1129): one decision per part, each with its own options. */
	parts?: AskPart[];
	/** On `waiting`: the reset instant the Engine named, unvalidated — the planner decides what it is worth. */
	waitUntil?: string;
	steps: number;
	transcript?: string[];
	/** On `max_steps`, when the brain answered the cap decision (#1261) — absent falls back to the generic ending. */
	capSummary?: CapSummary;
}

/** Side-effecting hooks — real ones hit the runner; tests mock them. */
export interface CodingDeps {
	snapshot: () => Promise<CodingPaneSnapshot>;
	act: (action: CodingActionKind) => Promise<CodingPaneSnapshot>;
	/** `atCap` (#1261): this is the one extra decision asked at the step cap — report, don't act. */
	decide: (params: { goal: CodingGoal; actionLog: string[]; snapshot: CodingPaneSnapshot; atCap?: boolean }) => Promise<CodingDecision>;
	/** Wait for the CLI to go idle (poll), returning the final snapshot. */
	waitIdle: () => Promise<CodingPaneSnapshot>;
	onEvent?: (type: string, message: string, data?: unknown) => Promise<void> | void;
}

/**
 * How many refusals the merge-authority screen may issue before the run finishes.
 *
 * The screen is a heuristic over natural language (see coding-authority.ts), so it needs a bound:
 * a brain that keeps rephrasing the same forbidden instruction must not burn all 40 BYOK-Claude
 * decisions doing it. Three is enough for the brain to genuinely change course after reading the
 * refusal in its own step log, and small enough that a false positive costs a stopped run with a
 * clear reason rather than a long silent one.
 */
const MAX_REFUSALS = 3;

/**
 * How many empty instructions in a row end the run (#504).
 *
 * CONSECUTIVE, and reset by any instruction that is actually sent, because the production run this
 * comes from recovered on its own: eleven of nineteen steps were empty, but the brain went back to
 * a short instruction each time it was told nothing had been sent. Three in a row is the point at
 * which it is not recovering, and stopping there costs a named failure instead of the 4.6 minutes
 * of engine turns and BYOK decisions that run spent driving "" into a live coding CLI.
 */
const MAX_EMPTY_INSTRUCTIONS = 3;

export async function runCodingLoop(deps: CodingDeps, goal: CodingGoal, opts: { maxSteps?: number; evidence?: CompletionEvidence } = {}): Promise<CodingResult> {
	const maxSteps = opts.maxSteps ?? 30;
	// The run's observed tool calls (#1019) — held by the workflow ACROSS rounds, so a claim is judged on the whole run.
	const evidence = opts.evidence ?? new CompletionEvidence();
	let scopeRefusals = 0;
	let finishPushedBack = false;
	const transcript: string[] = [];
	const actionLog: string[] = [];
	let refusals = 0;
	let askSentBack = false;
	let emptyInstructions = 0;
	/** Normalised key of every instruction actually driven into the engine, in order (#522). */
	const sentKeys: string[] = [];
	/**
	 * Parallel to `sentKeys` (#807): the file a sent instruction READ, or `""` when it read nothing.
	 * One entry per sent instruction so an index is an instruction ordinal, not a read ordinal.
	 */
	const sentReads: string[][] = [];
	/** The instruction this run was warned about repeating, if any — read by the `finish` branch. */
	let repeatedInstruction: string | null = null;
	/** Consecutive failed engine turns, deduped by the turn's own end-instant (#545). */
	let turns: TurnStreak = EMPTY_STREAK;

	for (let step = 0; step < maxSteps; step++) {
		let snap = await deps.snapshot();
		if (snap.cancelled) return { outcome: "cancelled", detail: snap.stopReason, steps: step, transcript };
		if (!snap.alive) {
			// A headless engine that could not sign in EXITS, so a dead session is where a lost login
			// most often surfaces (#881). Read its last words before calling it a crash.
			const block = engineSignInBlock(snap);
			if (block) return reauthResult(block, goal, step, transcript);
			// …and otherwise say what it DID print (#882): a missing binary is named, anything else
			// carries the engine's last lines instead of a constant.
			return { outcome: "failed", detail: deadSessionDetail(snap.pane), steps: step, transcript };
		}

		// Let the CLI finish whatever it's doing before deciding the next move.
		if (snap.runState !== "idle") {
			snap = await deps.waitIdle();
			if (snap.cancelled) return { outcome: "cancelled", detail: snap.stopReason, steps: step, transcript };
		}
		evidence.observe(snap.pane);
		// A write the scope guard refused (#1252) is told to the Pilot, in its step log, and to the owner.
		for (const r of evidence.takeRefusals()) {
			actionLog.push(describeWriteRefusal(r));
			await deps.onEvent?.("write_refused", describeWriteRefusal(r), r);
		}

		// THE ENGINE'S OWN VERDICT ON THE LAST TURN (#545), read BEFORE the brain is asked what to
		// do next — so the note lands in the step log this decision renders, not the one after it.
		//
		// The two guards above (`cancelled`, `!alive`) are the only things that ever stopped this
		// loop for an engine problem, and neither fires for a turn that exited 1: the session can
		// still take a turn, which is what `alive` means. So a Codex session refusing every
		// invocation looked exactly like a healthy one and the brain was handed the refusal as
		// prose, in the pane, three times.
		//
		// Deduped on the turn's end-instant because the same report is re-read on every poll —
		// the top-of-step snapshot, the `waitIdle` result and the next step's snapshot are three
		// sightings of ONE turn, and counting sightings would trip the bound on a single failure.
		const seen = observeTurn(turns, snap.lastTurn);
		turns = seen.streak;
		if (seen.newFailure) {
			// A turn refused on a dead login is not one of three strikes — no instruction and no retry
			// changes it, and only the owner signing the engine in does (#881).
			const block = engineSignInBlock(snap);
			if (block) return reauthResult(block, goal, step, transcript);
			const note = engineFailureNote(turns);
			actionLog.push(note);
			transcript.push(note);
			await deps.onEvent?.("engine_failed", note);
			// `failed`, not `stuck`: no human takeover fixes a CLI that refuses on every
			// invocation, and the production run's ending — a `request_human` nobody answered,
			// timing out to "failed — stuck not resolved in time" fifteen minutes later — is the
			// worst available one. The bound is CONSECUTIVE, so a run that recovers is untouched.
			if (turns.consecutive >= MAX_ENGINE_FAILURES) return { ...engineErrorEnding(turns, goal.repo, transcript), steps: step, transcript };
		}

		const decision = await deps.decide({ goal, actionLog, snapshot: snap });
		if (decision.thought) await deps.onEvent?.("thought", decision.thought);
		if (decision.cancelled) return { outcome: "cancelled", detail: decision.cancelled.why, steps: step, transcript };

		if (decision.finish) {
			// A completion CLAIM is held to the run's own tool calls (#1019): a contradiction the Pilot can
			// still fix (stale green run, focused-as-full, a push that moved nothing) goes back to it ONCE.
			const judged = decision.finish.status === "done" ? judgeCompletion(decision.finish.detail, evidence) : null;
			if (judged?.correctable.length && !finishPushedBack) {
				finishPushedBack = true;
				const note = finishRefusalNote(judged);
				actionLog.push(note);
				transcript.push(note);
				await deps.onEvent?.("evidence", note);
				continue;
			}
			// A `done` reached after the run repeated itself gets the measurement appended (#522). Run
			// 3c83b0e9 ended "All safely executable tests were run with zero failures" — true, and the
			// five specs the owner asked for were not among them. The loop cannot honestly rewrite the
			// brain's summary, so it states the one thing it measured and lets the reader check.
			const checked = judged ? evidenceNote(judged) : "";
			const detail = [decision.finish.detail, decision.finish.status === "done" && repeatedInstruction ? repeatCaution(repeatedInstruction) : "", checked].filter(Boolean).join("\n\n");
			transcript.push(`finish: ${decision.finish.status} — ${detail}`);
			return {
				outcome: decision.finish.status === "done" ? "done" : "failed",
				detail,
				steps: step,
				transcript,
			};
		}
		// THE ENGINE'S OWN LIMIT IS NOT A HANDOFF (#541). Returned rather than slept on: durability
		// belongs to the Workflow, exactly as it does for `stuck`, so this stays testable without one.
		if (decision.waitUntil) {
			const why = decision.waitUntil.why;
			transcript.push(`waiting: ${why}`);
			await deps.onEvent?.("waiting", why);
			return { outcome: "waiting", detail: why, waitUntil: decision.waitUntil.at, steps: step, transcript };
		}
		if (decision.stuck) {
			// The Pilot reading "Not logged in" off the pane and escalating is the case the runs in
			// #881 died of: a generic handoff nobody could perform from where they were. The pane
			// decides, not the brain's wording — the same narrow detector as everywhere else.
			const block = engineSignInBlock(snap);
			if (block) return reauthResult(block, goal, step, transcript);
			// The turn it is looking at CRASHED (#1200): "ask a person" is the brain reading that off the pane — say what the CLI said.
			if (turns.consecutive > 0) return { ...engineErrorEnding(turns, goal.repo, transcript), steps: step, transcript };
			return { outcome: "stuck", detail: decision.stuck.why, steps: step, transcript };
		}
		if (decision.needsInput?.incomplete && !askSentBack) {
			// #1224: a question that introduces choices and gives none would park as a headline nobody can
			// answer. Sent back once through the step log, as a merge refusal is; a second one parks free-form.
			askSentBack = true;
			const note = `ask_owner not sent: "${decision.needsInput.field}" introduces choices but gave no options — put them in options (or parts), a sentence each is fine, or ask the whole question in question`;
			actionLog.push(note);
			transcript.push(note);
			await deps.onEvent?.("refused", note);
			continue;
		}
		if (decision.needsInput) {
			const options = decision.needsInput.options ?? [];
			transcript.push(`needs_input: ${decision.needsInput.field}${options.length ? ` [${options.join(" | ")}]` : ""}`);
			const { fullQuestion, parts } = decision.needsInput;
			return { outcome: "needs_input", detail: decision.needsInput.why, fieldNeeded: decision.needsInput.field, ...(options.length ? { options } : {}), ...(fullQuestion ? { fullQuestion } : {}), ...(parts?.length ? { parts } : {}), steps: step, transcript };
		}
		if (!decision.action) {
			// No action and no terminal verdict → treat prose as a stuck signal — unless the last turn crashed (#1200).
			if (turns.consecutive > 0) return { ...engineErrorEnding(turns, goal.repo, transcript), steps: step, transcript };
			return { outcome: "stuck", detail: decision.thought ?? "no action chosen", steps: step, transcript };
		}

		// AN INSTRUCTION WITH NO WORDS IS NOT AN INSTRUCTION (#504). It was driven into the engine
		// anyway — `session.input("")` writes an empty user turn to Claude Code's stdin, the pane
		// flips to "thinking", and the loop then waits out a turn that was asked nothing. The owner
		// watching the Assistant tab read eleven "**Loop → engine** (step N): message:" lines with
		// nothing after them.
		//
		// Handled HERE, not in `toDecision`, because the invariant is about `deps.act` and this is the
		// only place every decider passes through — the workflow wraps `decide` in a budget
		// reservation, and a guard inside the Claude-backed mapper would not cover it.
		//
		// Fed back through `actionLog` exactly as a merge refusal is: the loop already talks to itself
		// through the step log the next decision renders, and the brain demonstrably reacts to it. The
		// note names the remedy (be shorter) because the leading hypothesis for the empties is an
		// instruction truncated at the output cap.
		if (decision.action.kind === "message" && !decision.action.text.trim()) {
			emptyInstructions++;
			const why = decision.truncated
				? "it was cut off at the model's output limit before any text arrived"
				: "the brain returned an instruction with no text";
			const note = `empty instruction not sent (${why}) — send a SHORTER, self-contained instruction`;
			actionLog.push(note);
			transcript.push(note);
			await deps.onEvent?.("empty", note);
			if (emptyInstructions >= MAX_EMPTY_INSTRUCTIONS) {
				return {
					outcome: "failed",
					detail: `The orchestrator produced ${emptyInstructions} empty instructions in a row (${why}). Nothing was sent to the engine — try again with a narrower objective.`,
					steps: step,
					transcript,
				};
			}
			continue;
		}
		emptyInstructions = 0;

		// MERGE AUTHORITY (#314): the orchestrator's own instruction is screened before it reaches
		// the Engine. This is the layer that would have stopped run 73ffc073 — its objective said
		// "merge each before starting the next" and the Pilot dutifully relayed it three times.
		//
		// The refusal goes into `actionLog`, which is rendered back to the brain as "Steps so far"
		// on the next decision, so it ADAPTS rather than repeating: the loop already communicates
		// with itself through that log and this needs no new channel. A no-op under the default
		// policy, where `screenInstruction` returns null for everything.
		const refusal = decision.action.kind === "message" ? screenInstruction(goal.mergePolicy ?? "merge", decision.action.text) : null;
		if (refusal) {
			refusals++;
			const note = `refused (merge authority): ${refusal}`;
			actionLog.push(note);
			transcript.push(note);
			await deps.onEvent?.("refused", refusal);
			// Finish with the reason rather than exhausting the step budget in silence. "failed" is
			// the honest status: the objective as given cannot be completed under this policy, and
			// the detail says exactly why so the owner can approve the merge themselves.
			if (refusals >= MAX_REFUSALS) return { outcome: "failed", detail: refusal, steps: step, transcript };
			continue;
		}
		// THE OWNER'S SCOPE (#1019), enforced on the instruction itself: refused before transport, like the merge screen above.
		const scoped = decision.action.kind === "message" ? screenScopedInstruction(goal.scopeConstraints ?? activeConstraints(constraintSources(goal)), decision.action.text) : null;
		if (scoped) {
			const note = `refused (owner constraint): ${scopeRefusalNote(scoped)}`;
			actionLog.push(note);
			transcript.push(note);
			await deps.onEvent?.("scope_refused", note);
			if (++scopeRefusals >= MAX_REFUSALS) return { outcome: "failed", detail: `Stopped: the orchestrator kept producing instructions outside the owner's constraints. Last: ${scopeRefusalNote(scoped)}`, steps: step, transcript };
			continue;
		}

		// REPEATED INSTRUCTION (#522). The two ways the Pilot gets stuck on one instruction — the CLI
		// refusing it, and the CLI answering it outside the terminal window the Pilot can read — are
		// indistinguishable from here and do not need to be told apart: both look like the same payload
		// going out again, and both are bounded by counting that. The prompt rule #505 added for the
		// first of them is prose, and a run repeated a byte-identical payload three times after it
		// deployed; this is the code-side counterpart.
		//
		// Keyed on the instruction (fenced command preferred), counted over a WINDOW rather than the
		// whole run — see coding-repetition.ts for why a naive consecutive-equality counter would have
		// killed a working 26-step run at step 21.
		if (decision.action.kind === "message") {
			const key = instructionKey(decision.action.text);
			const v = repetitionVerdict(sentKeys, key);
			if (v.verdict === "stop") {
				const why = repeatStopDetail(decision.action.text);
				transcript.push(why);
				await deps.onEvent?.("repeated", why);
				// `stuck`, not `failed`: a refusal on safety grounds and an unreadable answer are both
				// things a human settles in seconds, the takeover machinery already exists, and `failed`
				// throws away a session nine steps in. An unanswered handoff still times out to `failed`.
				return { outcome: "stuck", detail: why, steps: step, transcript };
			}
			if (v.verdict === "note") {
				repeatedInstruction = decision.action.text;
				const note = repeatNote(v);
				actionLog.push(note);
				transcript.push(note);
				await deps.onEvent?.("repeated", note);
			}
			sentKeys.push(key);

			// RE-READING (#807, widened at #822). The bound above keys on the payload, and "quote lines
			// 1-80 of x.ts" and "quote lines 80-200 of x.ts" are two payloads — run 6bc4dbf3 sent nine
			// of them and reached its first edit on step nine of ten. Keyed on WHAT is read instead —
			// every path, and `gh issue view N` — and a NOTE only, never a stop: a re-read after an
			// edit is real work, and the brain reacts to its own step log.
			const targets = readTargets(decision.action.text);
			const again = rereads(sentReads, targets);
			if (again.length) {
				const note = rereadNote(again);
				actionLog.push(note);
				transcript.push(note);
				await deps.onEvent?.("repeated", note);
			}
			sentReads.push(targets);
		}

		// SPEAKING FOR THE OWNER IS STAMPED WHERE IT IS SAID (#505), not only in the report.
		//
		// The run this comes from escalated an identical instruction from no authority, to "as
		// requested", to "the project owner has explicitly requested this exact wording" — and the
		// completion stamp shipped for #505 only ever reads the finish detail, 348 lines and three
		// minutes downstream of the sentence that did the damage. Stamped onto the step LABEL, which
		// is simultaneously the owner's chat line and the brain's own "Steps so far" — so the
		// platform's knowledge becomes something the Pilot reads back and adapts to, in the channel
		// the merge refusal and the repeat bound already use, rather than a rule it is arguing with.
		//
		// Annotated, never refused: whether an objective authorised a decision is a judgement over
		// prose, and a false positive that halts a run is expensive where a false positive that costs
		// one true sentence is not.
		//
		// "Has the owner spoken to this RUN" is the question, and `goal.userHint` alone answered a
		// narrower one: it holds a single round's message and is overwritten on the next resume,
		// frequently with `undefined`, because a resolved captcha is an owner turn that carries no
		// words. `ownerTurns` is the run-scoped count the workflow already keeps and the report-side
		// stamp already reads (`annotateOwnerAttribution`), so wiring it here is what stops the two
		// stamps disagreeing about the same fact.
		const ownerSpoke = (goal.ownerTurns ?? 0) > 0 || !!goal.userHint;
		const attribution = decision.action.kind === "message" ? instructionAttributionNote(decision.action.text, ownerSpoke) : null;
		const label = attribution ? `${describe(decision.action)}\n${attribution}` : describe(decision.action);
		// THE PILOT'S ONLY MEMORY (#822). Each decision is a fresh model call that sees this log and
		// the last few thousand characters of terminal — so what an engine reply SAID was gone two
		// steps later, and 13 of 40 sampled steps were the Pilot asking for it again. `learned` is
		// what it chose to keep, logged BEFORE the instruction it was decided alongside.
		if (decision.learned) {
			const learned = `${LEARNED_PREFIX}${decision.learned}`;
			actionLog.push(learned);
			transcript.push(learned);
			await deps.onEvent?.("learned", learned);
		}
		actionLog.push(label);
		transcript.push(label);
		// The ACTION rides along with its label. `describe` truncates to 120 characters and
		// prefixes the kind, which is right for a step log and useless as a transcript entry —
		// and the Pilot has to write the instruction it drove into `coding_timeline` VERBATIM
		// (#374). That record used to come from the `/message` route the browser Loop relayed
		// through, and nothing replaces it once the Pilot drives the engine instead.
		await deps.onEvent?.("action", label, decision.action);
		// An act the platform refused to send ends the run with ITS reason — on the last step too, not as max_steps (#1019).
		const acted = await deps.act(decision.action);
		if (acted?.cancelled) return { outcome: "cancelled", detail: acted.stopReason, steps: step + 1, transcript };
		// After sending an instruction, let the CLI run to completion before the
		// next decision — otherwise the brain reasons over a stale (pre-response)
		// pane and may double-send. waitIdle settles, then polls until idle.
		if (decision.action.kind === "message") await deps.waitIdle();
	}

	// #1261: ONE more decision when the brain runs out of steps — not to act, but to report
	// honestly what it did, the exact blocker, its plan (or that it has none), and how many more
	// steps it wants and why. Without this the cap ended on a bare "gave up after N steps" and the
	// owner's approval request (coding-pause.ts) carried a fixed-size ask with a hard-clipped tail
	// of the step log — the symptom #1261 was filed from.
	let capSnap = await deps.snapshot();
	if (capSnap.cancelled) return { outcome: "cancelled", detail: capSnap.stopReason, steps: maxSteps, transcript };
	if (capSnap.alive) {
		if (capSnap.runState !== "idle") capSnap = await deps.waitIdle();
		if (capSnap.cancelled) return { outcome: "cancelled", detail: capSnap.stopReason, steps: maxSteps, transcript };
		const capDecision = await deps.decide({ goal, actionLog, snapshot: capSnap, atCap: true });
		if (capDecision.cancelled) return { outcome: "cancelled", detail: capDecision.cancelled.why, steps: maxSteps, transcript };
		if (capDecision.capSummary) {
			const s = capDecision.capSummary;
			transcript.push(`max_steps: ${s.did || "(no actions reported)"} — blocked: ${s.blocker || "(no blocker stated)"}`);
			return { outcome: "max_steps", detail: `gave up after ${maxSteps} steps`, steps: maxSteps, transcript, capSummary: s };
		}
	}
	return { outcome: "max_steps", detail: `gave up after ${maxSteps} steps`, steps: maxSteps, transcript };
}

/** How much of each instruction the step log keeps — short on purpose (#822), and marked. */
const STEP_LOG_CHARS = 120;

function describe(a: CodingActionKind): string {
	switch (a.kind) {
		case "message":
			// Marked (#898): the Pilot re-reads this log on every decision, and a silent 120-char
			// cut made its own earlier instruction look like the whole of what it sent.
			return `message: ${a.text.length > STEP_LOG_CHARS ? `${a.text.slice(0, STEP_LOG_CHARS)}… [${a.text.length} chars in all]` : a.text}`;
		case "interrupt":
			return "interrupt (Ctrl-C)";
	}
}

// ── The Claude-backed decision (the actual "brain") ─────────────────────────

/**
 * Output ceiling for one Pilot decision (#504).
 *
 * This call inherited `runAnthropic`'s 1024-token fallback — the number #397's own docstring says
 * is "picked for nothing in particular" and lists every other caller as having replaced. The Pilot
 * is a caller that legitimately writes long: a `send_message` argument routinely carries a shell
 * script or a multi-file plan, and a tool call cut off at the cap is the empty instruction this
 * issue is about.
 *
 * 2048 tokens ≈ 8,000 characters of instruction, which fits a script comfortably, and
 * `generationBudgetMs(2048)` is 88s — inside both `AI_TOTAL_TIMEOUT_MS` (180s) and the decide
 * step's 3-minute Workflow timeout, which 4096 (156s) would leave almost no margin under. The
 * ceiling is the one that is affordable to WAIT for, not the largest one the model would accept.
 */
const PILOT_MAX_TOKENS = 2048;

/** Ceiling on one `learned` entry: ten steps of them still cost less than one terminal window. */
export const LEARNED_MAX = 300;

/**
 * How a `learned` entry is marked in the step log AND on its `brain` timeline row. Exported because
 * the row outlives the run: the resume note (#806) finds a stopped run's notes by this prefix, and
 * a second spelling of it there would silently find nothing the day this one changed.
 */
export const LEARNED_PREFIX = "[learned] ";

/** Exported for the contract test below: every advertised tool must have a `toDecision` case. */
export const CODING_TOOLS = [
	{
		name: "send_message",
		description: "Send a natural-language instruction to the coding CLI — a whole task where you can; it keeps its own memory of the session and you do not.",
		parameters: {
			type: "object",
			properties: {
				text: { type: "string" },
				learned: {
					type: "string",
					description: `Optional, at most ${LEARNED_MAX} characters: what the terminal just told you that you will still need at a later decision (what an issue asks for, which file holds what, what already landed). It is added to your step log, which is the ONLY thing you keep between decisions.`,
				},
			},
			required: ["text"],
		},
	},
	// NO press_keys. `HeadlessSession.key()` is an unconditional no-op — correct, because a
	// headless engine has no TTY to receive keystrokes — but the tool was still advertised, mapped
	// to `{kind:"keys"}`, routed into `key()` and answered with a normal snapshot, indistinguishable
	// from success. So a menu ("1) Sign in with…") produced: brain calls press_keys("Enter") →
	// nothing sent → unchanged pane → `waitIdle` is skipped for non-message actions → the next
	// decision sees the identical pane and repeats. The run burned all 40 decisions of BYOK Claude
	// and ended `max_steps` having done nothing. A menu is now a `request_human`, which is true.
	// #448 finished the job at the HTTP boundary: `POST …/message {keys}` answers 409 instead of
	// 200-with-a-snapshot, and `{kind:"keys"}` is gone from `CodingActionKind` entirely.
	{
		name: "finish",
		description: "The objective is complete (status 'done') or cannot be completed (status 'failed').",
		parameters: { type: "object", properties: { status: { type: "string", enum: ["done", "failed"] }, detail: { type: "string" } }, required: ["status", "detail"] },
	},
	{
		name: "request_human",
		description: "You are stuck and a human must take over the live session (e.g. an interactive auth prompt you can't answer).",
		parameters: { type: "object", properties: { why: { type: "string" } }, required: ["why"] },
	},
	{
		name: "request_user_info",
		description: "Ask the user for a specific value you do not have and must not invent (ask-and-hold).",
		parameters: { type: "object", properties: { field: { type: "string" }, why: { type: "string" } }, required: ["field"] },
	},
	// THE DECISION VERB (#960). Before it, a choice that was the owner's to make had only two exits:
	// decide it anyway (the CLI's "the user chose…" problem, #505), or `request_human`, which parks
	// as a hands-on takeover nobody can answer from a phone. This one parks as `decision` and the
	// owner answers it from a conversation — the console card, or answer_instance_input.
	{
		name: "ask_owner",
		description:
			"Ask the OWNER to choose, when the next step depends on a decision that is theirs to make and nothing in the objective, the rules or the repo settles it. Give one short question and 2–6 short options; the run pauses until they answer from chat or the console, and their answer comes back to you. When the owner must make SEVERAL separate decisions, give `parts` instead of `options` — one { question, options } per decision — and they answer each with a tap.",
		parameters: {
			type: "object",
			properties: {
				question: { type: "string", description: "One short question, answerable by picking an option. With `parts`, the one line that introduces them." },
				options: { type: "array", items: { type: "string" }, description: "2–6 short, distinct answers." },
				parts: {
					type: "array",
					description: "2–4 separate decisions, each answered on its own. Use instead of `options` when one question holds several choices.",
					items: {
						type: "object",
						properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } },
						required: ["question", "options"],
					},
				},
				why: { type: "string", description: "What depends on it — one line." },
			},
			required: ["question"],
		},
	},
	// THE VERB THAT DID NOT EXIST (#541). Without it, "the CLI is rate-limited until 22:30" had only
	// `request_human` to come out as — which binds the run to a 15-minute human deadline and killed
	// three real runs 41 minutes before the resource they were waiting for came back.
	{
		name: "wait_for_reset",
		description:
			"The coding CLI has hit ITS OWN usage/rate limit and cannot work until its window resets. Use this instead of request_human: no human can resolve a usage window, and the platform will sleep and resume you at the same step.",
		parameters: {
			type: "object",
			properties: {
				resetsAt: {
					type: "string",
					description:
						"When the CLI says its limit resets, as an absolute ISO-8601 instant WITH an explicit offset or Z (e.g. 2026-08-12T22:30:00+10:00). Convert the time the terminal states using the current time you were given. Omit this if the terminal states no reset time — never guess one.",
				},
				why: { type: "string", description: "Quote what the CLI actually said." },
			},
			required: ["why"],
		},
	},
] as const;

/**
 * The ONLY tool offered on the one cap decision (#1261) — never mixed into {@link CODING_TOOLS},
 * so a normal round can never reach for it and the cap round can never send another instruction.
 */
export const CAP_SUMMARY_TOOL = {
	name: "report_cap_status",
	description:
		"You have reached your step cap without finishing the objective. Report it honestly instead of sending another instruction: exactly what you did, your exact blocker, your concrete plan, and how many more steps you want and why.",
	parameters: {
		type: "object",
		properties: {
			did: {
				type: "string",
				description: "Concrete actions you took in the capped steps: files changed, commands run, commits you made — cite SHAs when you have them.",
			},
			blocker: { type: "string", description: "The exact error or blocker you are stuck on. Quote it in full — never summarize or shorten it." },
			plan: {
				type: "string",
				description:
					"A specific, concrete plan for what you would do in the next steps. If you genuinely have no concrete plan, say so plainly (e.g. 'No concrete plan: I am stuck repeating X') instead of inventing one.",
			},
			steps: { type: "number", description: "How many more steps you are asking for — the number YOU think you need, not a round default." },
			reason: { type: "string", description: "Why that many: say why you think you can finish in that many, and whether you might still need more." },
		},
		required: ["did", "blocker", "plan", "steps", "reason"],
	},
} as const;

/** The cap tool call → {@link CapSummary}. `null` when the brain did not call it (falls back to the generic ending). */
export function toCapSummary(call: { name: string; arguments: Record<string, unknown> } | undefined): CapSummary | null {
	if (!call || call.name !== CAP_SUMMARY_TOOL.name) return null;
	const a = call.arguments ?? {};
	const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
	const n = Number(a.steps);
	return { did: str(a.did), blocker: str(a.blocker), plan: str(a.plan), steps: Number.isFinite(n) && n > 0 ? Math.round(n) : 0, reason: str(a.reason) };
}

/**
 * Exported for its test. The two rules below are the Pilot-side half of #505 and they are prose, so
 * the only thing that can hold them is an assertion that they are still in the prompt.
 */
export function systemPrompt(goal: CodingGoal): string {
	return systemPromptText(systemPromptBlocks(goal));
}

/**
 * The Pilot's system prompt as cache blocks (#914, #1317).
 * Shared platform rules precede all run-specific content, so a new objective can reuse their cache.
 * Owner rules, engine, repo, objective and merge authority follow in a separate run block; the
 * latest directives and constraints remain last. Both stable prefixes use 1 hour because engine
 * turns routinely outlast the default 5-minute cache; the changing round tail stays uncached.
 */
export function systemPromptBlocks(goal: CodingGoal): SystemPromptBlock[] {
	const lines: string[] = [];
	lines.push(
		"You orchestrate a local AI coding CLI. Its run context follows these platform rules.",
		// #1319. A gate that refuses a stale checkout runs BEFORE any brief is read, so this cannot be the only defence (the platform
		// fast-forwards a behind checkout itself); it is the instruction for the case the platform could not settle, and for a run
		// that continues an old checkout.
		"FIRST STEP, before any change: have the CLI run `git pull --ff-only` on the repo's configured branch (main). If git refuses, stop and report exactly what it said (call request_human) — never merge, rebase, stash or reset your way past it.",
		"",
		"You see the terminal pane. Decide the SINGLE next step and call exactly one tool.",
		"- Drive the CLI with natural-language instructions via send_message; it does the editing/running.",
		"- You CANNOT send keystrokes: the CLI runs headless with no terminal attached. If it is waiting on a menu or a y/n prompt, phrase the answer as an instruction via send_message when the objective or rules settle it; when the choice is the OWNER's to make, call ask_owner with the options.",
		"- When the objective is satisfied, call finish(status:'done'). If it's impossible, finish(status:'failed').",
		"- If a value is required that only the user has, call request_user_info — NEVER invent secrets, tokens, or personal data.",
		"- If you hit something a human must handle live (interactive login, captcha), call request_human.",
		// #960. The three asks, told apart by WHAT the owner has to do — a value, a choice, or hands.
		"- If the next step needs a CHOICE that is the owner's (which of two approaches, whether to proceed with something irreversible or out of scope, which of several candidates) and the objective, rules and repo do not settle it, call ask_owner with one short question and 2–6 options — do NOT decide it yourself and do NOT use request_human, which needs someone at the machine. Never use ask_owner for something you can decide from the objective, for a value (request_user_info), or for hands-on work (request_human).",
		// #541. Stated as the DIFFERENCE between the two, because the three runs this comes from
		// escalated correctly under the old vocabulary — `request_human` was the only honest move
		// they had. The rule that matters is which of the two a usage window is, and why.
		"- If the CLI reports ITS OWN usage or rate limit (a subscription window that resets), call wait_for_reset — NOT request_human. A human cannot resolve a usage window by taking over the session; the platform will sleep until it resets and resume you at the same step. Convert the reset time the terminal states into an absolute instant WITH an offset, using the current time given to you below; if the terminal states no reset time, omit it rather than guessing.",
		"",
		// WHO IS WHO (#505). The runner writes your instruction to the CLI as `role: "user"`, so the
		// CLI's transcript calls YOU "the user" — and a Pilot that reads that back reported to the
		// owner that HE had been warned and had chosen, about a version bump he was never asked
		// about and which broke his deploy. The platform stamps a report that does this
		// (lib/run-attribution.ts); this is the rule that should mean it never has to.
		"WHO IS WHO: your instructions reach the CLI as a user turn, so when the terminal says \"the user\" — asked, was warned, chose, approved — it means YOU, not the human. The human is not watching this run and has not been asked anything.",
		"- NEVER report a decision as the human's. If you decided it, say that you decided it, and say why.",
		"- If the CLI objects to an instruction on grounds of correctness or safety, you may NOT simply repeat it. Either follow its recommendation, or call request_human quoting the objection — the human is the only one who can overrule the CLI on a judgement like that.",
		// A STALE BASE IS NOT A BASE (#785). Run 97903fb3 pushed to `main`; the checkout the next
		// run planned in had never fetched it. The platform now says so in the rules above this
		// prompt (UPSTREAM SYNC) — this is the standing rule for what to do about it, and for the
		// push at the end, which the Engine does and the platform cannot see until it has happened.
		"- STALE BASE: if the run context says the checkout is BEHIND its upstream and the tree is clean, your FIRST instruction is to fast-forward it (`git pull --ff-only`) — never plan a change against a base that is missing commits. If it is dirty or has diverged, do not merge or rebase on your own initiative: report it and call request_human.",
		"- BEFORE ANY PUSH: have the CLI `git fetch` and rebase (or merge) onto the upstream first, then push. If that brought in commits, name them in your finish detail — what landed upstream while you worked is a fact the owner must read, never a silent merge.",
		// WHAT YOU CAN SEE (#522, cause B). The Pilot was never told the size of its own window, so an
		// answer whose start had scrolled past read as an answer that never came — and the only move
		// that reading suggests is to ask again, which pushes it further out. This states the
		// measurement; renderPaneForPilot states the per-decision number on the pane itself.
		`- You see only the LAST ~${PILOT_PANE_CHARS} characters of the terminal, never all of it, and re-sending an instruction hoping earlier output will come back does not work — it will not come back.`,
		// WHO REMEMBERS WHAT (#822). Runs 45660130 and 0d14e23e spent 11 of 20 steps asking for an
		// issue or a file they had already been shown, because nothing of an engine reply survives to
		// the next decision. The engine is the opposite: it implemented a whole feature in the one
		// step that merely let it. So the rule is the asymmetry, and the two moves it implies.
		"- MEMORY: the CLI remembers everything it has read and done this session. YOU DO NOT — between decisions you keep only the step log below, not what the CLI answered. So hand the CLI WHOLE TASKS (\"read issue #N, implement it, run the full suite, push, comment on the issue, then report what landed\") rather than one read at a time, and never ask it to show you an issue or a file merely so that you can plan: it plans better from what it already holds.",
		"- When the terminal tells you something you will need later, put it in send_message's `learned` — that is the only thing that carries it to your next decision. Never ask again for something the step log shows you already asked for; the CLI still has it.",
		// WHAT A TOOL RESULT COSTS (#700). The bullet above used to end "ask for a bounded slice (a
		// line range, a grep, head/tail) rather than a full dump", and on the runner of the day that
		// advice could not work: EVERY tool_result was cut to 240 characters with all whitespace
		// collapsed before the pane existed, so `cat`, `sed -n '1,50p'`, `head -60` and `grep`
		// arrived at identical size and identical shape. One live run spent twelve of its sixteen
		// decisions searching that empty space, and the twelfth concluded — reasonably, on the
		// evidence in front of it — that "the CLI is summarizing file contents". It was not.
		//
		// `transcript-lines.ts` now keeps line structure and gives a content tool 1,500 characters,
		// so a slice that FITS does arrive whole — but only from a machine running
		// RESULT_LINES_MIN_CLI or later, and the cloud cannot tell which machine this is. So the
		// prompt states the mechanism rather than one number: a cut result SAYS it was cut, and says
		// by how much, and that is the signal to act on. The untruncated reply channel is named
		// either way, because it is the one that works on every runner ever published.
		"- A tool's OUTPUT is CUT before it reaches you, and a cut result says so at the end: `…`, or `…[cut: 1,500 of 18,432 chars]` when the machine is recent enough to state the figures. Roughly 1,500 characters of a file read or a command's output survive, keeping their line structure; on an older machine it is 240 characters with every newline and indent collapsed to spaces, and there NO shell command can show you a file at all.",
		"- So: if a result was cut, ask for a slice that FITS (`sed -n '1,40p'`) — but only ONCE. If the next result is cut at the same size and shape, this machine is capping every result identically and re-asking in a different command is the same request with the same bound.",
		"- The engine's own REPLY text is NEVER truncated, on any machine. To learn what is in a file, ask the engine to answer you with it — \"quote lines 1-40 of src/x.ts verbatim in your reply\" — or ask it a question about the file and use its answer.",
		"",
		"Never output step-by-step thinking; just call one tool.",
	);
	const run = ["\n\nRUN CONTEXT:"];
	const rules = [goal.standingInstructions, goal.specialInstructions].filter(Boolean).join("\n\n");
	if (rules) run.push(`USER RULES (highest priority):\n${rules}\n`);
	run.push(`Engine: "${goal.clientType}". Repository: "${goal.repo}".`, `OBJECTIVE: ${goal.objective}`);
	// Owner-set merge authority still follows and overrides conflicting objective/rules (#314).
	const authority = authorityInstruction(goal.mergePolicy ?? "merge");
	if (authority) run.push(`\n${authority}`);
	if (goal.dryRun) run.push("\nTEST MODE: avoid destructive or irreversible instructions; prefer read-only/plan steps.");
	const round: string[] = [];
	// Attributed to the PLATFORM, never folded into `userHint` — see CodingGoal.resumeNote.
	if (goal.resumeNote) round.push(`\n${goal.resumeNote}`);
	if (goal.userHint) round.push(`\nThe user just told you: ${goal.userHint}`);
	// Every round, not one (#1015): the owner's latest words outrank the objective for the whole run.
	if (goal.ownerDirectives?.length) round.push(ownerDirectivesBlock(goal.ownerDirectives));
	const binding = constraintsBlock(goal.scopeConstraints ?? activeConstraints(constraintSources(goal)));
	if (binding) round.push(binding);
	return [
		{ text: lines.join("\n"), cache: true, ttl: "1h", label: "platform" },
		{ text: run.join("\n"), cache: true, ttl: "1h", label: "run" },
		{ text: round.map((r) => `\n${r}`).join(""), label: "round" },
	];
}

export async function decideCodingAction(
	env: Env,
	userId: string,
	params: { goal: CodingGoal; actionLog: string[]; snapshot: CodingPaneSnapshot; atCap?: boolean },
	usageCtx?: UsageContext,
	/** This attempt's stream deadlines from the controller recovery policy (#907). */
	streamDeadlines?: StreamDeadlines,
): Promise<CodingDecision> {
	// #1261: the cap decision is a different question (report, don't act) with its own single tool —
	// routed here, not folded into the branches below, so the normal action prompt stays untouched.
	if (params.atCap) return decideCapSummary(env, userId, params, usageCtx, streamDeadlines);
	const system = systemPromptBlocks(params.goal);
	const steps = params.actionLog.length ? params.actionLog.map((a, i) => `${i + 1}. ${a}`).join("\n") : "(none yet)";
	const terminal = renderPaneForPilot(params.snapshot.pane, undefined, params.snapshot.paneChars);
	const userMsg = pilotUserBlocks({ actionLog: params.actionLog, clock: clockLine(Date.now(), params.goal.timeZone), runState: params.snapshot.runState, terminal });

	const res = await runPilotInference(env, userId, params.goal.pilotModel ?? DEFAULT_PILOT_MODEL, {
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: userMsg },
		],
		tools: CODING_TOOLS,
		maxTokens: PILOT_MAX_TOKENS,
		...(streamDeadlines ? { streamDeadlines } : {}),
	}, usageCtx
		? {
				...usageCtx,
				promptSource: "coding",
				promptPhase: "pilot_decide",
				promptSections: [
					...systemPromptSections("pilot.system", system),
					// `pilot.steps` below is the steps part of `pilot.user`; listed apart, as it always was.
					{ label: "pilot.objective", value: params.goal.objective },
					{ label: "pilot.steps", value: steps },
					{ label: "pilot.terminal", value: terminal },
					{ label: "pilot.tools", value: CODING_TOOLS },
				],
			}
			: undefined, (reply) => routinePilotReply(reply, params.goal));

	const truncated = hitOutputCap(res.stopReason);
	const call = res.tool_calls?.[0];
	if (!call) {
		// The two endings that used to read identically. "No action chosen" is a brain that replied
		// in prose; a cap stop is a brain whose tool call did not fit, which is a different problem
		// with a different remedy, and the owner is told which one happened.
		const unreadable = res.malformed_tool_calls?.[0];
		const why = truncated
			? "The decision was cut off at the model's output limit before it named an action."
			: unreadable
				? `The decision named ${unreadable.name}, but its arguments were not valid JSON (${unreadable.error}), so it was not acted on.`
				: res.response || "no action chosen";
		return { thought: res.response, stuck: { why }, usage: res.usage, truncated, pilotRouting: res.pilotRouting };
	}
	return { ...toDecision(call), usage: res.usage, thought: res.response, truncated, pilotRouting: res.pilotRouting };
}

/**
 * The one cap decision (#1261): same context as a normal round, one tool, and the brain is told
 * NOT to act. `toCapSummary` returning `null` (no call, or a different one) is read by the loop as
 * "the brain did not answer" and falls back to the old generic ending — never a crash.
 */
async function decideCapSummary(
	env: Env,
	userId: string,
	params: { goal: CodingGoal; actionLog: string[]; snapshot: CodingPaneSnapshot },
	usageCtx?: UsageContext,
	streamDeadlines?: StreamDeadlines,
): Promise<CodingDecision> {
	const system = systemPromptBlocks(params.goal);
	const steps = params.actionLog.length ? params.actionLog.map((a, i) => `${i + 1}. ${a}`).join("\n") : "(none yet)";
	const terminal = renderPaneForPilot(params.snapshot.pane, undefined, params.snapshot.paneChars);
	const userBlocks = pilotUserBlocks({ actionLog: params.actionLog, clock: clockLine(Date.now(), params.goal.timeZone), runState: params.snapshot.runState, terminal });
	// Appended to the LAST block rather than a new one, so the cache breakpoint `pilotUserBlocks`
	// already placed on the newest step is not pushed one block further out for this one-off call.
	const ask =
		"\n\nYou have reached your step cap without finishing. Call report_cap_status — do not send another instruction to the CLI. Report exactly what you did, your exact blocker quoted in full, a concrete plan (or say plainly you have none), and how many more steps you want and why.";
	userBlocks[userBlocks.length - 1] = { ...userBlocks[userBlocks.length - 1], text: `${userBlocks[userBlocks.length - 1].text}${ask}` };

	const res = await runPilotInference(
		env,
		userId,
		DEFAULT_PILOT_MODEL,
		{
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: userBlocks },
			],
			tools: [CAP_SUMMARY_TOOL],
			maxTokens: PILOT_MAX_TOKENS,
			...(streamDeadlines ? { streamDeadlines } : {}),
		},
		usageCtx
			? {
					...usageCtx,
					promptSource: "coding",
					promptPhase: "pilot_cap_summary",
					promptSections: [
						...systemPromptSections("pilot.system", system),
						{ label: "pilot.steps", value: steps },
						{ label: "pilot.terminal", value: terminal },
						{ label: "pilot.tools", value: [CAP_SUMMARY_TOOL] },
					],
				}
				: undefined,
		() => false,
		{ anthropicOnly: params.goal.pilotModel !== undefined && params.goal.pilotModel !== DEFAULT_PILOT_MODEL },
	);

	const capSummary = toCapSummary(res.tool_calls?.[0]);
	const pilotRouting = { ...res.pilotRouting, requestedModel: params.goal.pilotModel ?? DEFAULT_PILOT_MODEL, model: res.inference?.model ?? DEFAULT_PILOT_MODEL,
		...(params.goal.pilotModel && params.goal.pilotModel !== DEFAULT_PILOT_MODEL ? { fallbackReason: "Cap reports use Sonnet." } : {}) };
	return capSummary ? { capSummary, usage: res.usage, thought: res.response, pilotRouting } : { thought: res.response, usage: res.usage, pilotRouting };
}

/**
 * The Pilot's per-decision message, as prompt blocks (#914).
 *
 * "Steps so far" is append-only within a round, so it comes FIRST, one block per step, with a 1-hour
 * breakpoint after the newest: the next decision's prefix extends this one by a step, and the provider
 * finds the previous entry at the earlier block boundary — so only the newest step is written, and the
 * rest is read at a tenth of the price. Before this the message opened with the clock, which changes
 * every call, so the whole list was paid in full on every decision (~2.4k uncached tokens a call).
 *
 * The clock, the terminal tail and the instruction change every call and follow the breakpoint. 1 hour
 * for the reason the system prefix is (#914): decisions are minutes apart, past a 5-minute entry. The
 * clock is still per decision rather than per run (#541): a run that parks for an hour must convert the
 * CLI's stated local reset time against the time it is NOW.
 */
export function pilotUserBlocks(input: { actionLog: readonly string[]; clock: string; runState: string; terminal: string }): SystemPromptBlock[] {
	const tail = [
		input.clock,
		`\nTERMINAL (run-state: ${input.runState}):`,
		// Not a bare `slice(-6000)`: the tail is labelled with what it is a tail OF (#522, cause B).
		input.terminal,
		"\nDecide the next move toward the objective. Call exactly one tool.",
	].join("\n");
	if (!input.actionLog.length) return [{ text: `Steps so far:\n(none yet)\n${tail}`, label: "turn" }];
	const steps = input.actionLog.map((a, i): SystemPromptBlock => ({ text: `${i === 0 ? "Steps so far:\n" : "\n"}${i + 1}. ${a}`, label: "step" }));
	steps[steps.length - 1] = { ...steps[steps.length - 1], cache: true, ttl: "1h" };
	return [...steps, { text: `\n${tail}`, label: "turn" }];
}

export function toDecision(call: { name: string; arguments: Record<string, unknown> }): CodingDecision {
	const a = call.arguments ?? {};
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	switch (call.name) {
		case "send_message":
			// `author` is set HERE, at the one place the Pilot's instruction is born, because it is
			// the only place the platform can honestly answer "who wrote this" (#505, criterion 3).
			// The Engine receives every turn as `role: "user"` and cannot tell the Pilot from the
			// human — which is how a run came to tell the owner he had "explicitly chosen" a change
			// he was never asked about. The other doors into `/coding/act` (the console's manual
			// `/message`, MCP, the Overseer) declare nothing, and the runner renders that as
			// nothing rather than as a claim; see `packages/browser-runner/src/coding/turn-author.ts`.
			return { action: { kind: "message", text: str(a.text), author: "pilot" }, learned: str(a.learned).trim().slice(0, LEARNED_MAX) || undefined };
		case "press_keys":
			// No longer offered; if an older/cached tool list produces one, say so honestly rather
			// than routing it into a no-op that reads as success.
			return { stuck: { why: "Tried to press a key, but this session has no terminal attached — a human needs to answer the prompt." } };
		case "finish":
			return { finish: { status: str(a.status) === "failed" ? "failed" : "done", detail: str(a.detail) } };
		case "request_human":
			return { stuck: { why: str(a.why) || "needs a human" } };
		case "request_user_info":
			return { needsInput: { field: str(a.field) || "a value", why: str(a.why) } };
		case "ask_owner":
			return askOwnerDecision(a);
		case "wait_for_reset":
			// `at` is passed through UNVALIDATED. Judging it here would put the timezone rule in two
			// places, and the planner is the one that knows the run's remaining budget.
			return { waitUntil: { at: str(a.resetsAt) || undefined, why: str(a.why) || "the coding CLI reported its own usage limit" } };
		default:
			return { stuck: { why: `unknown tool ${call.name}` } };
	}
}

/** The loop's `needs_reauth` ending (#881): what the engine said, and what fixes it. */
export function reauthDetail(block: EngineAuthPrompt, clientType: CodingGoal["clientType"]): string {
	const said = block.evidence ? ` It said: "${block.evidence}".` : "";
	return `The ${clientType} engine is not signed in.${said} Sign it in with the re-auth relay (coding_engine_reauth) — it runs the engine's subscription login on the runner and relays it to any device; the run continues once it succeeds.`;
}

function reauthResult(block: EngineAuthPrompt, goal: CodingGoal, step: number, transcript: string[]): CodingResult {
	const detail = reauthDetail(block, goal.clientType);
	transcript.push(`needs_reauth: ${detail}`);
	return { outcome: "needs_reauth", detail, steps: step, transcript };
}
