import { runUserWorkersAi } from "./user-ai.js";
import { hitOutputCap } from "./reply-truncation.js";
import { authorityInstruction, screenInstruction, type MergePolicy } from "./coding-authority.js";
import {
	instructionKey,
	renderPaneForPilot,
	repeatCaution,
	repeatNote,
	repeatStopDetail,
	repetitionVerdict,
	PILOT_PANE_CHARS,
} from "./coding-repetition.js";
import { clockLine } from "./coding-wait.js";
import { instructionAttributionNote } from "./run-attribution.js";
import {
	EMPTY_STREAK,
	type EngineTurnReport,
	engineFailureDetail,
	engineFailureNote,
	MAX_ENGINE_FAILURES,
	observeTurn,
	type TurnStreak,
} from "./coding-turn-outcome.js";
import type { UsageContext } from "./usage.js";
import type { Env } from "../types.js";

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
	/** What the user wants done in this repo (the high-level task). */
	objective: string;
	/** Repo display name / path, for context. */
	repo: string;
	clientType: "claude" | "gemini" | "codex" | "grok";
	/** The user's free-text rules (Special Instructions), injected at top of prompt. */
	specialInstructions?: string;
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
	 * platform action to the human is exactly what #505 stamps reports for. Today its only writer is
	 * the resume note after a usage-limit park (`engineResumeNote`).
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
	 * What this run may do with the repo's trunk (#314). Resolved once by the workflow from the
	 * repo override / agent setting / platform default — see lib/coding-authority.ts. Absent behaves
	 * as `merge`, which is the pre-existing behaviour.
	 */
	mergePolicy?: MergePolicy;
}

/** What the orchestrator "sees": the current pane plus the CLI's run-state. */
export interface CodingPaneSnapshot {
	pane: string;
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
export type CodingActionKind = { kind: "message"; text: string } | { kind: "interrupt" };

/**
 * `waiting` is the only NON-TERMINAL member (#541): the Engine cannot work right now for a reason
 * that resolves on a clock rather than by anyone doing anything. The loop returns it, the workflow
 * parks and re-enters — and only when the run's wait budget is spent does it stay as the outcome,
 * which is why it must never be treated as a failure by the surfaces that read one.
 */
export type CodingOutcome = "done" | "stuck" | "needs_input" | "failed" | "max_steps" | "cancelled" | "waiting";

export interface CodingDecision {
	thought?: string;
	action?: CodingActionKind;
	finish?: { status: "done" | "failed"; detail: string };
	/** The orchestrator can't proceed without a human (stuck handoff). */
	stuck?: { why: string };
	/** A value only the user can provide (ask-and-hold). */
	needsInput?: { field: string; why?: string };
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
}

export interface CodingResult {
	outcome: CodingOutcome;
	detail?: string;
	fieldNeeded?: string;
	/** On `waiting`: the reset instant the Engine named, unvalidated — the planner decides what it is worth. */
	waitUntil?: string;
	steps: number;
	transcript?: string[];
}

/** Side-effecting hooks — real ones hit the runner; tests mock them. */
export interface CodingDeps {
	snapshot: () => Promise<CodingPaneSnapshot>;
	act: (action: CodingActionKind) => Promise<CodingPaneSnapshot>;
	decide: (params: { goal: CodingGoal; actionLog: string[]; snapshot: CodingPaneSnapshot }) => Promise<CodingDecision>;
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

export async function runCodingLoop(deps: CodingDeps, goal: CodingGoal, opts: { maxSteps?: number } = {}): Promise<CodingResult> {
	const maxSteps = opts.maxSteps ?? 30;
	const transcript: string[] = [];
	const actionLog: string[] = [];
	let refusals = 0;
	let emptyInstructions = 0;
	/** Normalised key of every instruction actually driven into the engine, in order (#522). */
	const sentKeys: string[] = [];
	/** The instruction this run was warned about repeating, if any — read by the `finish` branch. */
	let repeatedInstruction: string | null = null;
	/** Consecutive failed engine turns, deduped by the turn's own end-instant (#545). */
	let turns: TurnStreak = EMPTY_STREAK;

	for (let step = 0; step < maxSteps; step++) {
		let snap = await deps.snapshot();
		if (snap.cancelled) return { outcome: "cancelled", detail: snap.stopReason, steps: step, transcript };
		if (!snap.alive) return { outcome: "failed", detail: "coding session is not running", steps: step, transcript };

		// Let the CLI finish whatever it's doing before deciding the next move.
		if (snap.runState !== "idle") {
			snap = await deps.waitIdle();
			if (snap.cancelled) return { outcome: "cancelled", detail: snap.stopReason, steps: step, transcript };
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
			const note = engineFailureNote(turns);
			actionLog.push(note);
			transcript.push(note);
			await deps.onEvent?.("engine_failed", note);
			// `failed`, not `stuck`: no human takeover fixes a CLI that refuses on every
			// invocation, and the production run's ending — a `request_human` nobody answered,
			// timing out to "failed — stuck not resolved in time" fifteen minutes later — is the
			// worst available one. The bound is CONSECUTIVE, so a run that recovers is untouched.
			if (turns.consecutive >= MAX_ENGINE_FAILURES) {
				const detail = engineFailureDetail(turns, goal.repo);
				transcript.push(`finish: failed — ${detail}`);
				return { outcome: "failed", detail, steps: step, transcript };
			}
		}

		const decision = await deps.decide({ goal, actionLog, snapshot: snap });
		if (decision.thought) await deps.onEvent?.("thought", decision.thought);

		if (decision.finish) {
			// A `done` reached after the run repeated itself gets the measurement appended (#522). Run
			// 3c83b0e9 ended "All safely executable tests were run with zero failures" — true, and the
			// five specs the owner asked for were not among them. The loop cannot honestly rewrite the
			// brain's summary, so it states the one thing it measured and lets the reader check.
			const detail =
				decision.finish.status === "done" && repeatedInstruction
					? `${decision.finish.detail}\n\n${repeatCaution(repeatedInstruction)}`
					: decision.finish.detail;
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
			return { outcome: "stuck", detail: decision.stuck.why, steps: step, transcript };
		}
		if (decision.needsInput) {
			return { outcome: "needs_input", detail: decision.needsInput.why, fieldNeeded: decision.needsInput.field, steps: step, transcript };
		}
		if (!decision.action) {
			// No action and no terminal verdict → treat prose as a stuck signal.
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
		actionLog.push(label);
		transcript.push(label);
		// The ACTION rides along with its label. `describe` truncates to 120 characters and
		// prefixes the kind, which is right for a step log and useless as a transcript entry —
		// and the Pilot has to write the instruction it drove into `coding_timeline` VERBATIM
		// (#374). That record used to come from the `/message` route the browser Loop relayed
		// through, and nothing replaces it once the Pilot drives the engine instead.
		await deps.onEvent?.("action", label, decision.action);
		await deps.act(decision.action);
		// After sending an instruction, let the CLI run to completion before the
		// next decision — otherwise the brain reasons over a stale (pre-response)
		// pane and may double-send. waitIdle settles, then polls until idle.
		if (decision.action.kind === "message") await deps.waitIdle();
	}

	return { outcome: "max_steps", detail: `gave up after ${maxSteps} steps`, steps: maxSteps, transcript };
}

function describe(a: CodingActionKind): string {
	switch (a.kind) {
		case "message":
			return `message: ${a.text.slice(0, 120)}`;
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

/** Exported for the contract test below: every advertised tool must have a `toDecision` case. */
export const CODING_TOOLS = [
	{
		name: "send_message",
		description: "Send a natural-language instruction to the coding CLI (the next single step toward the objective).",
		parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
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
 * Exported for its test. The two rules below are the Pilot-side half of #505 and they are prose, so
 * the only thing that can hold them is an assertion that they are still in the prompt.
 */
export function systemPrompt(goal: CodingGoal): string {
	const lines: string[] = [];
	if (goal.specialInstructions) lines.push(`USER RULES (highest priority):\n${goal.specialInstructions}\n`);
	lines.push(
		`You orchestrate a local "${goal.clientType}" AI coding CLI running in a terminal in the repo "${goal.repo}".`,
		`OBJECTIVE: ${goal.objective}`,
		"",
		"You see the terminal pane. Decide the SINGLE next step and call exactly one tool.",
		"- Drive the CLI with natural-language instructions via send_message; it does the editing/running.",
		"- You CANNOT send keystrokes: the CLI runs headless with no terminal attached. If it is waiting on a menu or a y/n prompt, either phrase the answer as an instruction via send_message, or call request_human.",
		"- When the objective is satisfied, call finish(status:'done'). If it's impossible, finish(status:'failed').",
		"- If a value is required that only the user has, call request_user_info — NEVER invent secrets, tokens, or personal data.",
		"- If you hit something a human must handle live (interactive login, captcha), call request_human.",
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
		// WHAT YOU CAN SEE (#522, cause B). The Pilot was never told the size of its own window, so an
		// answer whose start had scrolled past read as an answer that never came — and the only move
		// that reading suggests is to ask again, which pushes it further out. This states the
		// measurement; renderPaneForPilot states the per-decision number on the pane itself.
		`- You see only the LAST ~${PILOT_PANE_CHARS} characters of the terminal, never all of it, and re-sending an instruction hoping earlier output will come back does not work — it will not come back.`,
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
	// Placed AFTER the objective and the user rules, and worded as overriding both, because the
	// conflict this exists for is with the objective itself — "merge each before starting the next"
	// is what a human typed. Null under the default policy, so the unconfigured prompt is unchanged.
	const authority = authorityInstruction(goal.mergePolicy ?? "merge");
	if (authority) lines.push(`\n${authority}`);
	if (goal.dryRun) lines.push("\nTEST MODE: avoid destructive or irreversible instructions; prefer read-only/plan steps.");
	// Attributed to the PLATFORM, never folded into `userHint` — see CodingGoal.resumeNote.
	if (goal.resumeNote) lines.push(`\n${goal.resumeNote}`);
	if (goal.userHint) lines.push(`\nThe user just told you: ${goal.userHint}`);
	return lines.join("\n");
}

export async function decideCodingAction(
	env: Env,
	userId: string,
	params: { goal: CodingGoal; actionLog: string[]; snapshot: CodingPaneSnapshot },
	usageCtx?: UsageContext,
): Promise<CodingDecision> {
	const userMsg = [
		// The clock, per decision rather than per run (#541): a run that parks for an hour and
		// resumes must convert the CLI's stated local reset time against the time it is NOW. In the
		// user message for that reason — the system prompt is built once and would go stale.
		clockLine(Date.now(), params.goal.timeZone),
		`Steps so far:\n${params.actionLog.length ? params.actionLog.map((a, i) => `${i + 1}. ${a}`).join("\n") : "(none yet)"}`,
		`\nTERMINAL (run-state: ${params.snapshot.runState}):`,
		// Not a bare `slice(-6000)`: the tail is labelled with what it is a tail OF (#522, cause B).
		renderPaneForPilot(params.snapshot.pane),
		"\nDo the single next step toward the objective. Call exactly one tool.",
	].join("\n");

	const res = (await runUserWorkersAi(env, userId, "claude-sonnet-4-6", {
		messages: [
			{ role: "system", content: systemPrompt(params.goal) },
			{ role: "user", content: userMsg },
		],
		tools: CODING_TOOLS,
		maxTokens: PILOT_MAX_TOKENS,
	}, usageCtx)) as {
		response?: string;
		tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }>;
		usage?: { input: number; output: number };
		stopReason?: string;
	};

	const truncated = hitOutputCap(res.stopReason);
	const call = res.tool_calls?.[0];
	if (!call) {
		// The two endings that used to read identically. "No action chosen" is a brain that replied
		// in prose; a cap stop is a brain whose tool call did not fit, which is a different problem
		// with a different remedy, and the owner is told which one happened.
		const why = truncated
			? "The decision was cut off at the model's output limit before it named an action."
			: res.response || "no action chosen";
		return { thought: res.response, stuck: { why }, usage: res.usage, truncated };
	}
	return { ...toDecision(call), usage: res.usage, thought: res.response, truncated };
}

export function toDecision(call: { name: string; arguments: Record<string, unknown> }): CodingDecision {
	const a = call.arguments ?? {};
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	switch (call.name) {
		case "send_message":
			return { action: { kind: "message", text: str(a.text) } };
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
		case "wait_for_reset":
			// `at` is passed through UNVALIDATED. Judging it here would put the timezone rule in two
			// places, and the planner is the one that knows the run's remaining budget.
			return { waitUntil: { at: str(a.resetsAt) || undefined, why: str(a.why) || "the coding CLI reported its own usage limit" } };
		default:
			return { stuck: { why: `unknown tool ${call.name}` } };
	}
}
