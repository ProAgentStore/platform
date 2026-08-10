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
	/**
	 * Error-class labels from recent agent replies, newest last.
	 * `null` entries mean a non-error reply. Used to detect a capability that is
	 * structurally unavailable (e.g. no GitHub Actions permission) so the loop stops
	 * burning iterations on it rather than rephrasing the same blocked request (#473).
	 */
	recentErrorClasses?: Array<string | null>;
}

export const MAX_ITERATIONS_CAP = 50;
/** Identical instruction this many times in a row ⇒ the loop is not progressing. */
export const NO_PROGRESS_REPEATS = 3;
/** Same error class this many times in a row ⇒ the capability is blocked for this run. */
export const BLOCKED_CAPABILITY_REPEATS = 3;

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
 * Classify an agent reply into a broad error class, or return null if it is not an error.
 *
 * The returned label is a stable string suitable for repetition-counting: we want "permission"
 * for everything that means "you don't have access", "notfound" for missing resources, and so on.
 * Precision matters less than stability — two replies that are the same flavour of failure must
 * map to the same label so the repeat-counter fires.
 *
 * Pure + exported so it is unit-testable without any I/O.
 */
export function replyErrorClass(reply: string): string | null {
	const r = (reply || "").toLowerCase();
	// Structurally terminal: a permission the agent cannot obtain by retrying differently.
	if (
		/\b(403|forbidden|permission denied|not (authorized|permitted|allowed)|access denied|insufficient (permissions?|privilege|scope)|unauthorized)\b/.test(r)
	) return "permission";
	// Resource does not exist — rephrasing the request won't create it.
	if (/\b(404|not found|no such|does not exist|could not find)\b/.test(r)) return "notfound";
	// Feature / tool the agent simply doesn't have access to on this plan or configuration.
	if (/\b(not (enabled|available|configured|supported)|feature (not|is not)|capability (not|is not)|plan (does not|doesn't)|unavailable)\b/.test(r)) return "capability";
	// Auth failures that survive retries.
	if (/\b(invalid (token|key|credentials?)|(?:token|session|key).{0,20}expired|expired.{0,20}(?:token|session|key)|authentication (failed|error)|401)\b/.test(r)) return "auth";
	return null;
}

/**
 * Has the same error class appeared consecutively enough times to conclude the capability is
 * structurally blocked for this run?
 *
 * Null entries (non-error replies) break a streak, so a single successful step resets the clock.
 * This is intentionally separate from `isStuck` (which tracks instruction hashes): an agent can
 * rephrase the same request many ways — each a distinct instruction — while every reply is the
 * same permission error. `isStuck` wouldn't fire; this does (#473).
 */
export function isCapabilityBlocked(recentErrorClasses: ReadonlyArray<string | null>): boolean {
	if (recentErrorClasses.length < BLOCKED_CAPABILITY_REPEATS) return false;
	const tail = recentErrorClasses.slice(-BLOCKED_CAPABILITY_REPEATS);
	const first = tail[0];
	return first !== null && tail.every((c) => c === first);
}

/**
 * Decide what the loop does next.
 *
 * Order matters and is deliberate: **terminal model decisions are honoured before the caps**, so a
 * run that genuinely finished on its last allowed iteration reports "done" rather than the
 * misleading "max_iterations". Budget is checked by the caller BEFORE the model runs (there is no
 * point paying for a decision you cannot act on), so it does not appear here.
 *
 * `agentReply` is the raw text the agent returned this iteration. When provided it is classified
 * into an error-class label, appended to `state.recentErrorClasses`, and checked for a blocked
 * capability — a structurally-impossible action the agent has been retrying in vain (#473).
 */
export function nextStep(
	state: LoopState,
	decision: { decision: LoopDecision; nextInstruction: string; reason: string },
	agentReply?: string,
): LoopVerdict {
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

	// Capability-blocked check (#473): if the agent's reply has signalled the same category of
	// structural error (permission, notfound, capability, auth) on each of the last N turns,
	// the orchestrator should NOT keep trying — rephrasing a forbidden request won't un-forbid it.
	// Escalate to a human instead so the missing permission/config can be addressed.
	if (agentReply !== undefined) {
		const errorClass = replyErrorClass(agentReply);
		const history = [...(state.recentErrorClasses ?? []), errorClass];
		if (isCapabilityBlocked(history)) {
			return {
				continue: false,
				stopReason: "escalated",
				message: `Stopped: the agent hit a "${errorClass}" error ${BLOCKED_CAPABILITY_REPEATS} times in a row — this capability appears unavailable. Check permissions or configuration and restart the loop.`,
			};
		}
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

/**
 * Read an agent turn out of an AgentDO `/chat` response.
 *
 * Its success shape is `{ message: AgentMessage, toolMessage? }` — `message` is an OBJECT, not a
 * string. Reading it as one yielded "[object Object]", which the orchestrator then judged as a
 * broken agent and failed the whole run. That shipped because the parsing lived inline in a
 * Workflow step, where nothing could test it; it lives here now so it can be.
 *
 * Tool output is prepended when present: a turn that only ran tools would otherwise look empty,
 * which the loop reads as no-progress and stops on.
 */
export function readAgentReply(body: unknown): string {
	const b = (body && typeof body === "object" ? body : {}) as {
		message?: unknown;
		toolMessage?: unknown;
		response?: unknown;
		error?: unknown;
	};
	if (typeof b.error === "string" && b.error) return `(the agent failed: ${b.error.slice(0, 500)})`;
	const textOf = (v: unknown): string => {
		if (typeof v === "string") return v;
		const c = (v as { content?: unknown } | null)?.content;
		return typeof c === "string" ? c : "";
	};
	const parts = [textOf(b.toolMessage), textOf(b.message) || (typeof b.response === "string" ? b.response : "")].filter(Boolean);
	return parts.join("\n\n").slice(0, 8000) || "(the agent returned nothing)";
}
