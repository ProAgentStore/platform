import { type AskPart } from "./coding-ask.js";
import { screenInstruction } from "./coding-authority.js";
import { instructionKey, readTargets, repeatCaution, repeatNote, repeatStopDetail, repetitionVerdict, rereadNote, rereads } from "./coding-repetition.js";
import { type ResetHint } from "./coding-wait.js";
import { engineSignInBlock, type EngineAuthPrompt } from "./engine-auth-prompt.js";
import { engineProviderError, providerTurnVerdict } from "./engine-provider-error.js";
import { deadSessionDetail } from "./coding-dead-session.js";
import { instructionAttributionNote } from "./run-attribution.js";
import { classifyTurn, EMPTY_STREAK, engineErrorEnding, engineFailureNote, MAX_ENGINE_FAILURES, observeTurn, type TurnStreak } from "./coding-turn-outcome.js";
import { activeConstraints, constraintSources, scopeRefusalNote, screenScopedInstruction } from "./coding-scope-constraints.js";
import { CompletionEvidence, evidenceNote, finishRefusalNote, judgeCompletion } from "./coding-completion-evidence.js";
import { describeWriteRefusal } from "./write-scope-refusals.js";
import { LEARNED_PREFIX } from "./coding-pilot.js";
import type { CodingGoal, CodingPaneSnapshot, CodingActionKind, CodingOutcome, CodingDecision, CapSummary } from "./coding-loop-types.js";

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

/**
 * The failed-turn streak, held by the workflow ACROSS rounds like `evidence` (#1344). A round used to start from an empty
 * streak, so the first snapshot after a park or a question re-read the turn before it as a new failure.
 */
export interface TurnCarry {
	turns: TurnStreak;
	/** Consecutive failed turns the engine's AI provider blamed on itself (#1326) — retried, not counted as strikes. */
	transientStreak: number;
	/**
	 * A turn worked since the last transient park (#1362). The workflow resets the transient-wait ladder on it, so the
	 * ladder bounds one outage: three short outages hours apart used to spend it, and the fourth ended the run.
	 */
	okTurnSeen?: boolean;
}

export async function runCodingLoop(deps: CodingDeps, goal: CodingGoal, opts: { maxSteps?: number; evidence?: CompletionEvidence; turnCarry?: TurnCarry } = {}): Promise<CodingResult> {
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
		const seen = observeTurn(carry.turns, snap.lastTurn);
		// A NEW turn that worked ends a transient run of failures; a re-read of the same turn changes nothing.
		if (seen.streak.lastAt !== carry.turns.lastAt && classifyTurn(snap.lastTurn) === "ok") {
			carry.transientStreak = 0;
			carry.okTurnSeen = true;
		}
		carry.turns = seen.streak;
		let retryingProvider = false;
		if (seen.newFailure) {
			// A turn refused on a dead login is not one of three strikes — no instruction and no retry
			// changes it, and only the owner signing the engine in does (#881).
			const block = engineSignInBlock(snap);
			if (block) return reauthResult(block, goal, step, transcript);
			// THE PROVIDER'S OWN WORDS (#1326): a usage window parks, a transient failure is retried, an empty account ends —
			// none is the engine refusing to run, so none spends one of the three strikes below.
			const verdict = providerTurnVerdict(engineProviderError(carry.turns.lastDetail, carry.turns.lastTail), carry.transientStreak, goal.repo);
			carry.transientStreak = verdict?.transientStreak ?? 0;
			if (verdict) carry.turns = { ...carry.turns, consecutive: Math.max(0, carry.turns.consecutive - 1) };
			if (verdict?.end) {
				transcript.push(`finish: engine_error — ${verdict.end}`);
				return { outcome: "engine_error", detail: verdict.end, steps: step, transcript };
			}
			if (verdict?.park) {
				transcript.push(`waiting: ${verdict.park}`);
				await deps.onEvent?.("waiting", verdict.park);
				return { outcome: "waiting", detail: verdict.park, waitKind: verdict.waitKind, ...(verdict.resetHint ? { resetHint: verdict.resetHint } : {}), steps: step, transcript };
			}
			if (verdict?.retry) {
				retryingProvider = true;
				actionLog.push(verdict.retry);
				transcript.push(verdict.retry);
				await deps.onEvent?.("engine_failed", verdict.retry);
			}
		}
		if (seen.newFailure && !retryingProvider) {
			const note = engineFailureNote(carry.turns);
			actionLog.push(note);
			transcript.push(note);
			await deps.onEvent?.("engine_failed", note);
			// `failed`, not `stuck`: no human takeover fixes a CLI that refuses on every
			// invocation, and the production run's ending — a `request_human` nobody answered,
			// timing out to "failed — stuck not resolved in time" fifteen minutes later — is the
			// worst available one. The bound is CONSECUTIVE, so a run that recovers is untouched.
			if (carry.turns.consecutive >= MAX_ENGINE_FAILURES) return { ...engineErrorEnding(carry.turns, goal.repo, transcript), steps: step, transcript };
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
			if (carry.turns.consecutive > 0) return { ...engineErrorEnding(carry.turns, goal.repo, transcript), steps: step, transcript };
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
export type { CodingGoal, CodingPaneSnapshot, CodingActionKind, CodingOutcome, CodingDecision, CapSummary } from "./coding-loop-types.js";
