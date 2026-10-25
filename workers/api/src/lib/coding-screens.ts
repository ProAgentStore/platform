/**
 * The screens an instruction passes before it reaches the engine (#1359): empty, merge authority, owner scope, repeat and
 * re-read. Extracted from `runCodingLoop` unchanged — same order, same bounds, same notes — as one function that takes the
 * run's {@link LoopCounters}, updates them, and returns what the loop should do and say.
 */
import { screenInstruction } from "./coding-authority.js";
import type { CodingActionKind, CodingGoal } from "./coding-loop-types.js";
import { MAX_EMPTY_INSTRUCTIONS, MAX_REFUSALS, type LoopCounters, type LoopEffect } from "./coding-loop-state.js";
import { instructionKey, readTargets, repeatNote, repeatStopDetail, repetitionVerdict, rereadNote, rereads } from "./coding-repetition.js";
import { activeConstraints, constraintSources, scopeRefusalNote, screenScopedInstruction } from "./coding-scope-constraints.js";

/**
 * What the loop does with the instruction:
 *   send → drive it into the engine
 *   skip → say the effects and ask the Pilot again (the step is spent)
 *   end  → say the effects and finish the run with this outcome and detail
 */
export type ScreenVerdict =
	| { kind: "send"; effects: LoopEffect[] }
	| { kind: "skip"; effects: LoopEffect[] }
	| { kind: "end"; effects: LoopEffect[]; outcome: "failed" | "stuck"; detail: string };

export function screenAction(counters: LoopCounters, goal: CodingGoal, decision: { action: CodingActionKind; truncated?: boolean }): ScreenVerdict {
	const { action } = decision;
	const effects: LoopEffect[] = [];

	// EMPTY INSTRUCTION (#504): nothing is sent, and the Pilot is told so in its own step log.
	if (action.kind === "message" && !action.text.trim()) {
		counters.emptyInstructions++;
		const why = decision.truncated ? "it was cut off at the model's output limit before any text arrived" : "the brain returned an instruction with no text";
		const note = `empty instruction not sent (${why}) — send a SHORTER, self-contained instruction`;
		effects.push({ log: note, transcript: note, event: { name: "empty", detail: note } });
		if (counters.emptyInstructions >= MAX_EMPTY_INSTRUCTIONS) {
			return {
				kind: "end",
				effects,
				outcome: "failed",
				detail: `The orchestrator produced ${counters.emptyInstructions} empty instructions in a row (${why}). Nothing was sent to the engine — try again with a narrower objective.`,
			};
		}
		return { kind: "skip", effects };
	}
	counters.emptyInstructions = 0;

	// MERGE AUTHORITY (#314). A no-op under the default policy, where `screenInstruction` returns null for everything.
	const refusal = action.kind === "message" ? screenInstruction(goal.mergePolicy ?? "merge", action.text) : null;
	if (refusal) {
		counters.refusals++;
		const note = `refused (merge authority): ${refusal}`;
		effects.push({ log: note, transcript: note, event: { name: "refused", detail: refusal } });
		// "failed" is the honest status: the objective as given cannot be completed under this policy.
		if (counters.refusals >= MAX_REFUSALS) return { kind: "end", effects, outcome: "failed", detail: refusal };
		return { kind: "skip", effects };
	}

	// THE OWNER'S SCOPE (#1019), enforced on the instruction itself: refused before transport, like the merge screen.
	const scoped = action.kind === "message" ? screenScopedInstruction(goal.scopeConstraints ?? activeConstraints(constraintSources(goal)), action.text) : null;
	if (scoped) {
		const note = `refused (owner constraint): ${scopeRefusalNote(scoped)}`;
		effects.push({ log: note, transcript: note, event: { name: "scope_refused", detail: note } });
		if (++counters.scopeRefusals >= MAX_REFUSALS) {
			return { kind: "end", effects, outcome: "failed", detail: `Stopped: the orchestrator kept producing instructions outside the owner's constraints. Last: ${scopeRefusalNote(scoped)}` };
		}
		return { kind: "skip", effects };
	}

	if (action.kind === "message") {
		// REPEATED INSTRUCTION (#522), counted over a WINDOW (see coding-repetition.ts).
		const key = instructionKey(action.text);
		const v = repetitionVerdict(counters.sentKeys, key);
		if (v.verdict === "stop") {
			const why = repeatStopDetail(action.text);
			// `stuck`, not `failed`: a human settles this in seconds and the takeover machinery already exists. Transcript only.
			effects.push({ transcript: why, event: { name: "repeated", detail: why } });
			return { kind: "end", effects, outcome: "stuck", detail: why };
		}
		if (v.verdict === "note") {
			counters.repeatedInstruction = action.text;
			const note = repeatNote(v);
			effects.push({ log: note, transcript: note, event: { name: "repeated", detail: note } });
		}
		counters.sentKeys.push(key);

		// RE-READING (#807, widened at #822): keyed on WHAT is read, and a NOTE only, never a stop.
		const targets = readTargets(action.text);
		const again = rereads(counters.sentReads, targets);
		if (again.length) {
			const note = rereadNote(again);
			effects.push({ log: note, transcript: note, event: { name: "repeated", detail: note } });
		}
		counters.sentReads.push(targets);
	}
	return { kind: "send", effects };
}
