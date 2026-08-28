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
 * itself. The interrupting classes are the ones where the run was cut off by something other than
 * the work it was asked to do — see {@link INTERRUPTED_CLASSES}.
 */
import { classifyCodingFailure, type CodingFailureClass } from "./coding-failure.js";
import { isRunnerGone } from "./runner-unreachable.js";
import type { LoopStopReason } from "./agent-loop.js";

/**
 * Deaths that are NOT the objective failing — and the SUBJECT each one is reported with.
 *
 * Every member was cut off by something other than the work, with the run's committed acts intact:
 *
 *   `workflow_internal`  Cloudflare Workflows failed its own attempt (#546).
 *   `platform_ceiling`   a per-invocation subrequest/CPU/memory limit (#523).
 *   `infra_transient`    an isolate or Durable Object reset, usually a deploy landing mid-run.
 *   `provider_stall`     the model's transport died mid-reply, after the resumes were spent (#758).
 *
 * `runner_gone` is deliberately NOT here even though it is also not the objective failing. #341
 * already gives it its own sentence, and it differs in the one way that matters to the owner: the
 * machine is not coming back on its own, so it is an ACTION rather than an interruption. Widening
 * this set to include it would replace a message that was written for that case with a generic one.
 *
 * ── Why a subject per class, rather than one sentence (#758)
 *
 * The sentence was *"Interrupted by the platform"*, which is true of the first three and false of
 * the fourth: the model provider is the owner's own BYOK account, not this platform, and telling
 * them our platform interrupted their run sends them to look at the wrong system. #546 and #523 are
 * both tickets about a death being reported as something it was not; naming the fourth class with
 * the third's sentence would be the same defect, one class over. The TAIL is shared, because what
 * the owner has to DO is identical — the committed work is intact and the repository is the thing
 * to check before starting again.
 */
const INTERRUPTED_BY: Partial<Record<CodingFailureClass, string>> = {
	workflow_internal: "interrupted by the platform",
	platform_ceiling: "interrupted by the platform",
	infra_transient: "interrupted by the platform",
	provider_stall: "cut off by the AI provider",
};

export const INTERRUPTED_CLASSES: ReadonlySet<CodingFailureClass> = new Set(Object.keys(INTERRUPTED_BY) as CodingFailureClass[]);

/**
 * What cut this run off, as a clause — or null when the objective itself is what failed.
 *
 * Lower-case and clause-shaped on purpose: its three readers place it differently (a chat headline,
 * a sentence opener, mid-sentence in a `loop.interrupted` event), and a subject stored already
 * capitalised is a subject that can only lead. {@link openWith} is the one place that capitalises.
 */
export function interruptedBy(cls: CodingFailureClass): string | null {
	return INTERRUPTED_BY[cls] ?? null;
}

/** Sentence-case a clause. Only the first character — the rest may legitimately be `AI`, `Cloudflare`. */
function openWith(clause: string): string {
	return clause.charAt(0).toUpperCase() + clause.slice(1);
}

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
	const subject = INTERRUPTED_BY[classifyCodingFailure(err).class];
	if (!subject) {
		return { detail: `run error: ${message}`, stopReason: null };
	}
	return {
		// ORDER IS THE FIX, not just the words (#523). The card this lands on has 300 characters
		// (`card-detail.ts`), and measured on the ticket's own run they were spent — in order — on the
		// outcome, the raw Cloudflare message, 81 characters of Wrangler URL, and then a cut mid-word
		// at "unaffected; …", with `| Acts: pushed directly to the trunk origin main; and 14 more.`
		// falling off the end entirely. The owner therefore read a docs link for a Worker he does not
		// own and no record of the fifteen pushes that had already landed. What a reader must ACT on
		// comes first; the vendor's own text, which is evidence rather than instruction, comes last
		// and is the thing that gets cut. The raw message is unaltered in the durable error log —
		// `recordCodingFailure` is handed the error itself — so nothing is lost by not repeating it
		// here.
		detail:
			`${openWith(subject)}, not by the objective — whatever this run had already committed ` +
			`or pushed is unaffected; check the repository before starting it again. ${withoutVendorAdvice(message)}`,
		stopReason: "interrupted",
	};
}

/**
 * The ⏸ line a driver posts while a run is being REPLAYED, rather than ended (#758).
 *
 * Extracted from `workflows/coding-session.ts`, where it was a template literal that hardcoded
 * *"Interrupted by a platform update"*. That was written when `infra_transient` was the only class
 * `DRIVER_RESUME_POLICY` resumed and it was exactly true. It is now reachable for a provider
 * transport drop, where it would tell an owner that we deployed over their run — a specific, checkable,
 * false claim, on the surface they read first.
 *
 * Pure, and shared by both resuming drivers, so the chat bubble, the loop event and the terminal
 * sentence cannot end up naming three different culprits for one death. `agent-loop.ts` carried its
 * own copy of the same wrong sentence.
 */
export function resumeNotice(cls: CodingFailureClass, why: string, attempt: number, max: number): string {
	// Falls back to the neutral subject rather than asserting a cause: a class that resumes without
	// an entry above is a gap in the table, and inventing "a platform update" for it is how the
	// sentence this function replaces became wrong in the first place.
	const subject = INTERRUPTED_BY[cls] ?? "interrupted";
	return `⏸ **${openWith(subject)}** — ${why}. Resuming from where it stopped (interruption ${attempt} of ${max}); nothing is needed from you.`;
}

/**
 * Drop advice addressed to whoever OPERATES the Worker from a sentence addressed to its subscriber.
 *
 * "To configure this limit, refer to <wrangler docs>" is true, actionable and aimed at us: the
 * limit lives in `workers/api/wrangler.toml`, which was raised to `subrequests = 100_000` under this
 * same ticket. A subscriber cannot act on it, and it cost 81 of the card's 300 characters — the
 * ticket's title is that link appearing where the account of his run should have been.
 *
 * Textual, and deliberately narrow: only Cloudflare's own docs URLs and the clause that introduces
 * one. Everything else the platform says about itself survives, because a message this cannot parse
 * must reach the owner intact rather than be quietly emptied.
 */
export function withoutVendorAdvice(message: string): string {
	return message
		.replace(/\s*\bto configure this limit,?\s*refer to\s+\S+/gi, "")
		.replace(/\s*\b(?:see|refer to)\s+https?:\/\/(?:developers|dash)\.cloudflare\.com\/\S*/gi, "")
		.replace(/\s*https?:\/\/(?:developers|dash)\.cloudflare\.com\/\S*/gi, "")
		.trim();
}

/**
 * The word the note LEADS with — the run's own outcome, unless the platform overruled it.
 *
 * ── Why this is not just `input.outcome` (#523)
 *
 * The workflow's catch sets `result = { outcome: "failed", … }` for every death, because "failed"
 * is the only `CodingOutcome` a run that threw can carry. {@link codingCrashReport} then corrects
 * the SENTENCE and `statusFor` corrects the COLUMN — an interruption lands in "Needs you",
 * not "Failed" — but the note's first four words were still composed from that placeholder. So the
 * one string that both the board card and `check_delegation` show read, in full:
 *
 *   > outcome: failed — Interrupted by the platform, not by the objective — Too many API requests…
 *
 * A sentence that contradicts itself inside its own first line, on the surface a supervisor reads
 * to decide whether to re-run two hours of work that had already been pushed. #523's acceptance
 * says it outright: it "must not be reported as `outcome: failed` with no qualification".
 *
 * The stop reason is the correction, and the caller passes the SAME value `finishLoopRun` records —
 * so the word the owner reads and the reason the platform filed cannot disagree. Only `interrupted`
 * overrides: it is the only reason `codingCrashReport` produces, and the only one that is a
 * statement about the platform rather than about the objective. `stopReasonFor` cannot produce it
 * from any outcome (asserted in `coding-run-report.test.ts`), so no ordinary ending is reworded.
 *
 * The workflow is required to compose its note through this — `coding-run-report.test.ts` reads
 * `workflows/coding-session.ts` and fails if the call goes back to passing the raw outcome, which
 * is the only way the placeholder could return.
 */
export function outcomeWord(outcome: string, stopReason?: LoopStopReason | null): string {
	return stopReason === "interrupted" ? "interrupted" : outcome;
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
	/**
	 * The word this run ends on — {@link outcomeWord} of the outcome and the reason being recorded,
	 * never the raw `CodingOutcome`, which is a placeholder for every death (#523).
	 */
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
