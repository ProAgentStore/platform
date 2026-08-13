/**
 * How a finished Pilot run is REPORTED — the sentence, the stop reason, the board status (#546).
 *
 * Pure. Extracted from `workflows/coding-session.ts`, which was 799 lines against an 800-line
 * ratchet, for the same reason `coding-pause.ts` was: "what does the owner get told when a run
 * ends" is a rule, and a rule that lives inside a Workflow can only be tested by running one.
 *
 * ── The defect this module is named for
 *
 * The workflow's catch turned everything that was not {@link isRunnerGone} into
 * `` `run error: ${message}` `` and let `stopReasonFor("failed")` call it `failed`. That sentence
 * is a claim about the OBJECTIVE, and for a whole class of deaths it is false. Two of the five
 * `WorkflowInternalError` runs carry `| Acts: pushed directly to the trunk origin main` — the run
 * had already done the work and pushed it, and was reported to its owner as a failure. He could
 * not tell a dead run from a finished one, so he retried; that is the measured cost, and it is the
 * same cost #523 records for the subrequest ceiling.
 *
 * So an INTERRUPTION is reported as itself, exactly as #341 already reports a waited-out runner as
 * itself. The three interrupting classes are the ones where the run was cut off by the platform
 * rather than by anything it was asked to do — see {@link INTERRUPTED_CLASSES}.
 */
import { classifyCodingFailure, type CodingFailureClass } from "./coding-failure.js";
import { isRunnerGone } from "./runner-unreachable.js";
import type { LoopStopReason } from "./agent-loop.js";

/**
 * Deaths that are NOT the objective failing.
 *
 * Each is the platform cutting the invocation off, with the run's committed work intact:
 *
 *   `workflow_internal`  Cloudflare Workflows failed its own attempt (#546).
 *   `platform_ceiling`   a per-invocation subrequest/CPU/memory limit (#523).
 *   `infra_transient`    an isolate or Durable Object reset, usually a deploy landing mid-run.
 *
 * `runner_gone` is deliberately NOT here even though it is also not the objective failing. #341
 * already gives it its own sentence, and it differs in the one way that matters to the owner: the
 * machine is not coming back on its own, so it is an ACTION rather than an interruption. Widening
 * this set to include it would replace a message that was written for that case with a generic one.
 */
export const INTERRUPTED_CLASSES: ReadonlySet<CodingFailureClass> = new Set<CodingFailureClass>([
	"workflow_internal",
	"platform_ceiling",
	"infra_transient",
]);

export interface CodingCrashReport {
	/** What the owner is told. Feeds `CodingResult.detail`, the chat line and the loop-run row. */
	detail: string;
	/**
	 * The loop-run reason to record INSTEAD of the one the outcome implies, or null to keep it.
	 *
	 * Null for the two cases that already had a sentence — a waited-out runner (#341) and an
	 * ordinary crash — so this change adds a reason where there was none and rewrites none.
	 */
	stopReason: LoopStopReason | null;
}

/**
 * Read a thrown run.
 *
 * Classifies internally rather than taking a {@link CodingFailure}, so the caller does not have to
 * hold the record's return value across a `.catch()` — `recordCodingFailure` is best-effort by
 * design, and the sentence the owner reads must not depend on whether the log write succeeded.
 */
export function codingCrashReport(err: unknown): CodingCrashReport {
	const message = err instanceof Error ? err.message : String(err ?? "");
	// A waited-out runner is reported as ITSELF, without the "run error:" prefix — that prefix
	// reads as a crash, and "the runner did not come back" is a finding, not one (#341).
	if (isRunnerGone(err)) return { detail: message, stopReason: null };
	if (!INTERRUPTED_CLASSES.has(classifyCodingFailure(err).class)) {
		return { detail: `run error: ${message}`, stopReason: null };
	}
	return {
		detail:
			`Interrupted by the platform, not by the objective — ${message}. ` +
			"Whatever this run had already committed or pushed is unaffected; check the repository before starting it again.",
		stopReason: "interrupted",
	};
}

/**
 * The one-line account of a run that both the loop-run row and the board card carry.
 *
 * Extracted verbatim from the workflow so the ORDER stays a stated rule: a breach is named AHEAD
 * of the ordinary act summary — buried after "and 3 more" it would be the same invisibility #314
 * is about — and the policy line rides along whenever one is in force, so even a run that behaved
 * shows the authority it ran under.
 */
export function runOutcomeNote(input: {
	/** The `CodingOutcome`, as its own word. */
	outcome: string;
	/** The run's own account of itself, already owner-attributed (#505). */
	detail: string;
	/** Unauthorized acts, already described. Empty when there were none. */
	breach: string;
	/** What authority this run ran under, or null under the default policy. */
	authorityNote: string | null;
	/** What it actually did (#294). Empty or null when nothing was reported. */
	actLine: string | null;
}): string {
	const head = `outcome: ${input.outcome}${input.detail ? ` — ${input.detail}` : ""}`;
	return [head, input.breach && `POLICY VIOLATION: ${input.breach}`, input.authorityNote, input.actLine].filter(Boolean).join(" | ");
}
