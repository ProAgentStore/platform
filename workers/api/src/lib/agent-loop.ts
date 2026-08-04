// Policy for the platform's durable agent loop (#158) — pure, so the rules that decide when an
// autonomous run stops are testable without a Workflow, a model, or D1.
//
// Why this exists at all. The platform already owns the *thinking*: `/v1/instances/:id/loop-decide`
// lives in routes/instances.ts (not coding.ts) and is agent-generic. The browser owned the
// *persistence*: the console polled that endpoint and sent the next instruction, so closing the
// tab killed an in-flight objective. Two consequences followed — an objective could not survive a
// phone lock, and spend could not be bounded, because you cannot budget a loop you do not drive.
//
// This module is the referee. The model proposes (`loop-decide`); these rules dispose.

import type { LoopDecision } from "./loop-decide.js";

/** Why a run ended. Every one of these is a DIFFERENT thing to tell a human. */
export type LoopStopReason =
	| "done" // the objective was met
	| "escalated" // needs a human
	| "failed" // the agent reported failure
	| "max_iterations" // hit the caller's iteration cap
	| "budget" // the tree ran out of money/delegations (#184)
	| "cancelled" // a human stopped it
	| "no_progress"; // repeating itself — a loop that cannot terminate on its own

export interface LoopState {
	iteration: number;
	maxIterations: number;
	/** Hashes of recent instructions, newest last — used to notice a stuck loop. */
	recentInstructions: string[];
}

export const MAX_ITERATIONS_CAP = 50;
/** Identical instruction this many times in a row ⇒ the loop is not progressing. */
export const NO_PROGRESS_REPEATS = 3;

export interface LoopVerdict {
	/** Run another iteration? */
	continue: boolean;
	stopReason?: LoopStopReason;
	/** The instruction to send when continuing. */
	nextInstruction?: string;
	/** Human-facing explanation, always set when stopping. */
	message?: string;
}

/** Clamp a caller-supplied iteration cap into something a durable runner can honour. */
export function sanitizeMaxIterations(raw: unknown): number {
	const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 10;
	return Math.max(1, Math.min(MAX_ITERATIONS_CAP, n));
}

/** Cheap stable hash for instruction-repeat detection. Not security-sensitive. */
export function instructionKey(instruction: string): string {
	const s = (instruction || "").trim().toLowerCase().replace(/\s+/g, " ");
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(36);
}

/**
 * Is the loop repeating itself?
 *
 * A model that emits the same instruction over and over is not making progress, and left alone it
 * burns the whole budget discovering that. `parseLoopDecision` already infers "failed" from
 * obvious self-repetition in prose, but that depends on the model *noticing*; this does not.
 */
export function isStuck(recentInstructions: readonly string[]): boolean {
	if (recentInstructions.length < NO_PROGRESS_REPEATS) return false;
	const tail = recentInstructions.slice(-NO_PROGRESS_REPEATS);
	return tail.every((k) => k === tail[0]);
}

/**
 * Decide what the loop does next.
 *
 * Order matters and is deliberate: **terminal model decisions are honoured before the caps**, so a
 * run that genuinely finished on its last allowed iteration reports "done" rather than the
 * misleading "max_iterations". Budget is checked by the caller BEFORE the model runs (there is no
 * point paying for a decision you cannot act on), so it does not appear here.
 */
export function nextStep(state: LoopState, decision: { decision: LoopDecision; nextInstruction: string; reason: string }): LoopVerdict {
	if (decision.decision === "done") {
		return { continue: false, stopReason: "done", message: decision.reason || "Objective met." };
	}
	if (decision.decision === "escalate") {
		return { continue: false, stopReason: "escalated", message: decision.reason || "The agent needs your input." };
	}
	if (decision.decision === "failed") {
		return { continue: false, stopReason: "failed", message: decision.reason || "The agent reported a failure." };
	}

	// decision === "continue" from here.
	if (state.iteration >= state.maxIterations) {
		return {
			continue: false,
			stopReason: "max_iterations",
			message: `Stopped after ${state.maxIterations} iterations without finishing.`,
		};
	}
	const instruction = (decision.nextInstruction || "").trim();
	if (!instruction) {
		// "continue" with nothing to do would spin at full cost producing nothing.
		return { continue: false, stopReason: "no_progress", message: "The orchestrator asked to continue but gave no next instruction." };
	}
	if (isStuck([...state.recentInstructions, instructionKey(instruction)])) {
		return {
			continue: false,
			stopReason: "no_progress",
			message: `Stopped: the same instruction repeated ${NO_PROGRESS_REPEATS} times without progress.`,
		};
	}
	return { continue: true, nextInstruction: instruction };
}

/** Does this ending need a human? Drives whether the run notifies rather than closing quietly. */
export function needsHuman(reason: LoopStopReason): boolean {
	return reason === "escalated" || reason === "failed" || reason === "budget" || reason === "no_progress";
}

/** Terminal status for the run record — mirrors the vocabulary pipeline runs already use. */
export function statusFor(reason: LoopStopReason): "completed" | "failed" | "needs_human" | "cancelled" {
	if (reason === "done") return "completed";
	if (reason === "cancelled") return "cancelled";
	if (reason === "escalated") return "needs_human";
	return "failed";
}
