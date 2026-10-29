import type { AskPart } from "./coding-ask.js";
import { repeatCaution } from "./coding-repetition.js";
import type { ResetHint } from "./coding-wait.js";
import { engineSignInBlock, type EngineAuthPrompt } from "./engine-auth-prompt.js";
import { deadSessionDetail } from "./coding-dead-session.js";
import { instructionAttributionNote } from "./run-attribution.js";
import { EMPTY_STREAK, engineErrorEnding, foldTurn, type TurnCarry } from "./coding-turn-outcome.js";
import type { ProviderErrorRecord } from "./engine-provider-error.js";
import { CompletionEvidence, evidenceNote, finishRefusalNote, judgeCompletion } from "./coding-completion-evidence.js";
import { describeWriteRefusal } from "./write-scope-refusals.js";
import { LEARNED_PREFIX } from "./coding-pilot.js";
import { newLoopCounters, LOOP_FALLBACK_MAX_STEPS, type LoopEffect } from "./coding-loop-state.js";
import { screenAction } from "./coding-screens.js";
import type { CapSummary, CodingActionKind, CodingDecision, CodingGoal, CodingOutcome, CodingPaneSnapshot } from "./coding-loop-types.js";

export type { TurnCarry } from "./coding-turn-outcome.js";

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
	/** On `waiting` read from the CLI's own words (#1344): when the limit lifts, placed in time by the planner. */
	resetHint?: ResetHint;
	/** On `waiting` (#1344): `transient` parks on a short ladder of its own, never the usage-limit budget. */
	waitKind?: "limit" | "transient";
	/** On a provider-caused `waiting` / `engine_error` (#1391): the classification and the whole error text, for the park's events and the final detail. */
	providerError?: ProviderErrorRecord;
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

export async function runCodingLoop(deps: CodingDeps, goal: CodingGoal, opts: { maxSteps?: number; evidence?: CompletionEvidence; turnCarry?: TurnCarry } = {}): Promise<CodingResult> {
	const maxSteps = opts.maxSteps ?? LOOP_FALLBACK_MAX_STEPS;
	// The run's observed tool calls (#1019) — held by the workflow ACROSS rounds, so a claim is judged on the whole run.
	const evidence = opts.evidence ?? new CompletionEvidence();
	const counters = newLoopCounters();
	const transcript: string[] = [];
	const actionLog: string[] = [];
	/** Say one effect a pure helper asked for: the Pilot's step log, the transcript, then the listener — in that order. */
	const say = async (e: LoopEffect): Promise<void> => {
		if (e.log !== undefined) actionLog.push(e.log);
		if (e.transcript !== undefined) transcript.push(e.transcript);
		if (e.event) await deps.onEvent?.(e.event.name, e.event.detail, e.event.data);
	};
	/** Consecutive failed engine turns, deduped by the turn's own end-instant (#545), carried across rounds (#1344). */
	const carry: TurnCarry = opts.turnCarry ?? { turns: EMPTY_STREAK, transientStreak: 0 };

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
		const folded = foldTurn(carry, snap, { repo: goal.repo, signInBlock: () => engineSignInBlock(snap) });
		Object.assign(carry, folded.carry);
		for (const e of folded.effects) await say(e);
		if (folded.ending?.kind === "reauth") return reauthResult(folded.ending.block, goal, step, transcript);
		if (folded.ending) {
			const { kind: _kind, ...result } = folded.ending;
			return { ...result, steps: step, transcript };
		}

		const decision = await deps.decide({ goal, actionLog, snapshot: snap });
		if (decision.thought) await deps.onEvent?.("thought", decision.thought);
		if (decision.cancelled) return { outcome: "cancelled", detail: decision.cancelled.why, steps: step, transcript };

		if (decision.finish) {
			// A completion CLAIM is held to the run's own tool calls (#1019): a contradiction the Pilot can
			// still fix (stale green run, focused-as-full, a push that moved nothing) goes back to it ONCE.
			const judged = decision.finish.status === "done" ? judgeCompletion(decision.finish.detail, evidence) : null;
			if (judged?.correctable.length && !counters.finishPushedBack) {
				counters.finishPushedBack = true;
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
			const detail = [decision.finish.detail, decision.finish.status === "done" && counters.repeatedInstruction ? repeatCaution(counters.repeatedInstruction) : "", checked].filter(Boolean).join("\n\n");
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
			if (carry.turns.consecutive > 0) return { ...engineErrorEnding(carry.turns, goal.repo, transcript), steps: step, transcript };
			return { outcome: "stuck", detail: decision.stuck.why, steps: step, transcript };
		}
		if (decision.needsInput?.incomplete && !counters.askSentBack) {
			// #1224: a question that introduces choices and gives none would park as a headline nobody can
			// answer. Sent back once through the step log, as a merge refusal is; a second one parks free-form.
			counters.askSentBack = true;
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
			if (carry.turns.consecutive > 0) return { ...engineErrorEnding(carry.turns, goal.repo, transcript), steps: step, transcript };
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
		// The screens an instruction passes before it reaches the engine: empty (#504), merge authority (#314), the owner's scope (#1019),
		// repeat (#522) and re-read (#807). See coding-screens.ts.
		const screened = screenAction(counters, goal, { action: decision.action, truncated: decision.truncated });
		for (const e of screened.effects) await say(e);
		if (screened.kind === "end") return { outcome: screened.outcome, detail: screened.detail, steps: step, transcript };
		if (screened.kind === "skip") continue;

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

// The Pilot moved to `coding-pilot.ts` (#1359); re-exported so existing importers are unchanged.
export { CAP_SUMMARY_TOOL, CODING_TOOLS, LEARNED_MAX, LEARNED_PREFIX, decideCodingAction, pilotUserBlocks, systemPrompt, systemPromptBlocks, toCapSummary, toDecision } from "./coding-pilot.js";
export type { CodingGoal, CodingPaneSnapshot, CodingActionKind, CodingOutcome, CodingDecision, CapSummary, RecordCursor } from "./coding-loop-types.js";
