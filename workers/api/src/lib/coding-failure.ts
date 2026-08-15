/**
 * Why a Pilot run died, in a form a machine can file and a human can read (#529).
 *
 * ── The gap this closes
 *
 * `grep -c logError workers/api/src/workflows/coding-session.ts` returned 0, while `job-apply`
 * logged 4, `browser-task` 4, `pipeline-run` 5 and `agent-loop` 3. A CODING_SESSION run that threw
 * therefore existed nowhere durable: not in `list_errors`, not in `agent_trace`, not on the board —
 * only as a `**Loop stopped** (failed)` chat bubble the owner had to scroll to. Three runs on one
 * instance died on the SAME instruction on 2026-08-12 and none of the three could be read back.
 *
 * ── Why a classifier and not just a message
 *
 * The workflow's catch block already had one classified escape (`isRunnerGone`, #341) and turned
 * everything else into `run error: <raw string>`. Those raw strings are not one thing:
 *
 *   a provider STALL         transport died mid-reply. Retrying is genuinely the right move.
 *   a CREDENTIALS/CREDIT     the key is invalid, or the balance is gone. No retry will help;
 *                            the owner has to do something.
 *   a PLATFORM CEILING       a Cloudflare per-invocation limit (#523). Not the objective failing
 *                            at all — the run was cut off, and its committed work is intact.
 *
 * They read identically today, which is exactly why nobody could say whether the 07:18 death was a
 * stall or the `credit balance is too low` the same account hit 50 minutes earlier. So the class is
 * recorded as a FIELD, following the same rule as #339/#341: the site that knows says so, rather
 * than a catch site guessing from wording.
 *
 * ── Why the matching is textual as well as structural
 *
 * A Cloudflare Workflow serialises a thrown error across a step boundary: the receiving side gets a
 * message, not a prototype (the reasoning is written out in `runner-unreachable.ts`). Every provider
 * failure here is raised INSIDE `step.do`, so `instanceof UserAiProviderError` cannot be relied on.
 * Structural fields are read when they survive and the platform's own sentences are matched when
 * they do not — and `coding-failure.test.ts` feeds this the real output of `deadlineMessage()` /
 * `connectionLostMessage()`, so a reworded message fails the test instead of silently degrading
 * every future stall to `unknown`.
 */
import { countInterruption } from "./agent-loop-store.js";
import { logError } from "./error-log.js";
import { isRetryableFailure, resumableRoundOf } from "./resumable-round.js";
import { isRunnerGone, isRunnerUnreachable } from "./runner-unreachable.js";
import { isTransientInfraError } from "./transient-error.js";
import type { Env } from "../types.js";

/** What killed the run, at the granularity the remedies differ at. */
export type CodingFailureClass =
	/** The machine was waited for and never came back (#341). A finding, not a crash. */
	| "runner_gone"
	/** The relay lost the socket mid-command. Heals on its own. */
	| "runner_unreachable"
	/** The model's transport died — never started, stopped mid-reply, socket dropped. */
	| "provider_stall"
	/** The reply was too long to finish inside the total ceiling. Deterministic: retrying repeats it. */
	| "provider_overrun"
	/** No usable key, an invalid one, or an exhausted balance. Only the owner can clear it. */
	| "provider_credentials"
	/** The provider is throttling this key. Wants a backoff, not an immediate retry. */
	| "provider_rate_limit"
	/** The provider answered, and the answer was an error we have not split out. */
	| "provider_error"
	/** A Cloudflare per-invocation limit — subrequests, CPU, memory (#523). */
	| "platform_ceiling"
	/** A Durable Object / isolate reset, usually a deploy landing mid-run. */
	| "infra_transient"
	/**
	 * A Cloudflare WORKFLOWS attempt error — the orchestrator failed, not the run (#546).
	 *
	 * The largest live class after `stuck`, and until this it landed in `unknown` along with
	 * everything genuinely unexplained, which made "is `unknown` shrinking?" unanswerable.
	 *
	 * It is NOT terminal, and that is measured rather than argued: run `82739cb6` filed its own
	 * death twice, eight minutes apart, with the same `runId` and the same `runStartedAt` and
	 * `elapsedMs` differing by exactly the wall-clock gap. One run, two attempts — Cloudflare had
	 * already retried it. See {@link CodingRunProbe} for the replay signature that confirms it.
	 */
	| "workflow_internal"
	/** Nothing matched. Deliberately its own class — see `unknown` in the record. */
	| "unknown";

export interface CodingFailure {
	class: CodingFailureClass;
	/**
	 * Could an identical immediate retry plausibly work?
	 *
	 * `null` where nothing established it. Never guessed: the cost of guessing wrong is the owner's
	 * own provider credit, which is the same reason `UserAiProviderError.retryable` defaults false.
	 */
	retryable: boolean | null;
	/** The provider's own HTTP status, when one reached us. */
	upstreamStatus: number | null;
}

/** Anything that carries a status/retryable field, whichever of them survived serialisation. */
type ErrorLike = { message?: unknown; upstreamStatus?: unknown; status?: unknown; retryable?: unknown };

/** Cloudflare's own ceilings. The strings are the runtime's, and they are what reaches the catch. */
const CEILING_MARKERS = [
	"too many api requests by single worker invocation",
	"too many subrequests",
	"exceeded cpu",
	"cpu time limit",
	"exceeded memory",
	"exceeded resource limits",
];

/** No key, a rejected key, or no money behind it — three doors, one remedy: the owner acts. */
const CREDENTIAL_MARKERS = [
	"credit balance is too low",
	"credit balance too low",
	"invalid api key",
	"add an api key",
	"add your cloudflare workers ai account id",
	"authentication_error",
	"permission_error",
];

/** The transport failures. Sourced from `ai-deadlines.ts`; the test feeds it those functions' output. */
const STALL_MARKERS = [
	"did not begin replying",
	"stopped sending mid-reply",
	"ended mid-reply",
	"carried no body to stream",
	"the reply arrived empty",
];

/** The one deadline that is deterministic: the reply was too LONG, so a retry ends the same way. */
const OVERRUN_MARKERS = ["was still being written after", "too long to finish"];

/**
 * Cloudflare Workflows failing its own attempt. TWO wordings, one event (#546).
 *
 * The surface decides which one reaches us: a step that exhausts its retries throws
 * `WorkflowInternalError: Attempt failed due to internal workflows error` (what the five
 * pre-#529 `agent_loop_runs.detail` rows carry), while the runtime's own error carries
 * `internal error; reference = <id>` (what the three post-#529 `error_log` rows carry). Both are
 * matched, and `coding-failure.test.ts` feeds this the literal production strings, so a reworded
 * Cloudflare message fails a test instead of silently degrading the class back to `unknown`.
 */
const WORKFLOW_INTERNAL_MARKERS = [
	"attempt failed due to internal workflows error",
	"workflowinternalerror",
	"internal error; reference =",
];

/**
 * Cloudflare's per-occurrence support handle, split off the message it is embedded in (#546).
 *
 * `reference = <random id>` makes every occurrence's message byte-unique, and `collapseRepeat`
 * keys on exact message text — so all three production rows read `repeat_count: 1` and the
 * frequency of the single most common coding failure was not countable off the log at all. The
 * repeat machinery #522/#538 built was inert for the one class that most needed a count.
 *
 * Moved rather than deleted, and moved into `context` rather than normalised away: the reference
 * is a DATUM (it is what a Cloudflare support ticket is opened with), and it was only ever
 * uncollapsible because a caller had put a unique id into prose. `error-log.ts`'s own rule —
 * "exact text carries no extra information by definition, which is what makes collapsing it
 * lossless" — is true of every message that does not do this, so the fix belongs at the caller
 * that broke the premise and not in the collapse. Both ends survive: `context` keeps the first
 * occurrence's reference, `last_context` the latest (#538).
 *
 * ── The reference is NOT hex, and this shipped believing it was (#546)
 *
 * The first version of this matched `[0-9a-f-]{6,}`, written against a fabricated example, and was
 * tested against the same fabrication. Cloudflare's handles are lowercase base36:
 *
 *     ta78s8dpekde3apmplf351m0   hknsjlipbemc1fi7lsn13vak   v5t1f9uth3ba0so067pi9qq5
 *
 * — read off the three production rows that carry one (2026-08-12 15:05:34, 15:13:35 and 2026-08-15
 * 08:37:34). Every one of them contains a letter past `f`, so the regex matched NONE of them: all
 * three rows still carry the reference in the collapse key and read `repeat_count: 1`, and a sweep of
 * all 124 rows in the error log finds `cfReference` in the context of exactly zero. The remedy
 * shipped, the docblock above described it in the present tense, and in production it had never once
 * fired. The test below is now fed those three literal strings, which is what the first one should
 * have been fed — a fixture invented to match the pattern can only ever confirm it.
 */
export function splitCfReference(message: string): { message: string; reference: string | null } {
	const m = /\breference\s*=\s*([0-9a-z][0-9a-z-]{5,})/i.exec(message);
	if (!m) return { message, reference: null };
	return { message: message.replace(m[0], "reference = (see context)"), reference: m[1] };
}

function numeric(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** `Anthropic (400): …` / `Cloudflare Workers AI request failed with HTTP 429` — the status in prose. */
function statusFromMessage(message: string): number | null {
	const paren = /\((\d{3})\)/.exec(message);
	if (paren) return Number(paren[1]);
	const http = /http (\d{3})/i.exec(message);
	return http ? Number(http[1]) : null;
}

/** Read the failure. Pure, total, and never throws — it runs on a path that is already failing. */
export function classifyCodingFailure(err: unknown): CodingFailure {
	const e = (err ?? {}) as ErrorLike;
	const message = err instanceof Error ? err.message : typeof e.message === "string" ? e.message : String(err ?? "");
	const m = message.toLowerCase();
	const upstreamStatus = numeric(e.upstreamStatus) ?? statusFromMessage(message);
	const declared = typeof e.retryable === "boolean" ? e.retryable : null;
	const at = (cls: CodingFailureClass, retryable: boolean | null = declared): CodingFailure => ({
		class: cls,
		retryable,
		upstreamStatus,
	});

	// The runner first: it is the one class this file did not invent, and #341's guard has already
	// decided the machine is gone rather than merely quiet.
	if (isRunnerGone(err)) return at("runner_gone", false);
	if (isRunnerUnreachable(err)) return at("runner_unreachable", true);
	// Before the provider checks: a ceiling message can quote whatever the run was doing when the
	// invocation ran out, and it is not a statement about the model.
	if (CEILING_MARKERS.some((k) => m.includes(k))) return at("platform_ceiling", false);
	if (isTransientInfraError(message)) return at("infra_transient", true);
	// Before the provider branches for the same reason the ceiling is: this is the ORCHESTRATOR
	// failing, and its message can quote whatever the run happened to be doing. `retryable: true`
	// is a statement about the ATTEMPT — the thing Cloudflare has already retried, safely, because
	// journalled `step.do` results replay and the Engine is not re-driven. It is NOT a licence to
	// re-dispatch the RUN: two of the five occurrences had already pushed to `origin main`, and a
	// fresh run has no journal, so every act would repeat. Nothing reads this field but a human
	// (`coding-failure.test.ts` pins that), and it stays honest by saying which retry it means.
	if (WORKFLOW_INTERNAL_MARKERS.some((k) => m.includes(k))) return at("workflow_internal", true);
	// Credit/credentials BEFORE the generic provider branch: `Anthropic (400): Your credit balance
	// is too low` is a 4xx that says nothing about transport, and reporting it as a stall is exactly
	// the confusion #529 was filed over.
	if (CREDENTIAL_MARKERS.some((k) => m.includes(k)) || upstreamStatus === 401 || upstreamStatus === 402 || upstreamStatus === 403) {
		return at("provider_credentials", false);
	}
	if (upstreamStatus === 429 || m.includes("rate_limit") || m.includes("rate limit")) return at("provider_rate_limit", false);
	if (OVERRUN_MARKERS.some((k) => m.includes(k))) return at("provider_overrun", false);
	if (STALL_MARKERS.some((k) => m.includes(k))) return at("provider_stall", declared ?? true);
	// A malformed/truncated stream reaches us as `Anthropic: <transport fact>` with `retryable`
	// already true — the same physical event as the sentences above, worded by the provider.
	if (declared === true && (m.startsWith("anthropic:") || (upstreamStatus ?? 0) >= 500)) return at("provider_stall", true);
	if (m.startsWith("anthropic") || m.includes("workers ai request failed") || upstreamStatus !== null) return at("provider_error");
	return at("unknown");
}

/**
 * Which classes are BUGS, and which are merely recorded (#424).
 *
 * `warn` is not "less important" — it is "explained". A machine that went offline, a deploy that
 * reset an isolate, an exhausted balance and a throttled key all have a known cause and a known
 * remedy, and counting them as bugs is what buries the ones that are. A stall, a platform ceiling
 * and an unclassified death are things somebody should look at, so they stay `error`.
 */
const EXPLAINED: ReadonlySet<CodingFailureClass> = new Set<CodingFailureClass>([
	"runner_gone",
	"runner_unreachable",
	"infra_transient",
	"provider_credentials",
	"provider_rate_limit",
	"provider_overrun",
	// #546. Explained AND countable — the two have to land together. Demoting it to `warn` without
	// {@link splitCfReference} would make the largest live coding failure class both quiet and
	// uncountable, which is strictly worse than the noisy `unknown` it replaces.
	"workflow_internal",
]);

export function codingFailureLevel(cls: CodingFailureClass): "error" | "warn" {
	return EXPLAINED.has(cls) ? "warn" : "error";
}

// ── Who consumes the `retryable` verdict, and at what cost (#583) ────────────

/**
 * How many PLATFORM interruptions one run may be resumed through.
 *
 * Bounded for #518's reason and sized against a different cost. #518 allows a chat turn exactly two
 * attempts because *"a turn that retries until it succeeds spends someone else's credit deciding
 * when to stop"*. A resume here spends none: the run is a durable Workflow, so letting the error
 * escape `run()` replays a JOURNAL — every step that already succeeded returns its recorded result
 * without re-executing, and only the step that died runs again. The owner pays for at most one
 * re-executed step, and only if that step was the model call.
 *
 * So the bound is not about money, it is about a loop: an interruption that recurs on every attempt
 * is not a deploy, it is a defect, and three is where "the platform is being deployed around this
 * run" stops being a plausible explanation. The measured storm — seven API deploys in 48 minutes,
 * one run killed 56 seconds after `4c0826b` landed — is covered several times over.
 */
export const MAX_PLATFORM_RESUMES = 3;

export interface ResumeRule {
	/** May a run that died this way be RESUMED, rather than ended? */
	resume: boolean;
	/** The reason, in the words a reader should get instead of inferring a rule from a boolean. */
	why: string;
}

/**
 * The consumer #583 says is missing, written as a TOTAL table over every failure class.
 *
 * The defect this closes is not "the Pilot does not retry". It is that `retryable` was computed,
 * recorded on every death, and read by nobody — a verdict written for a reader that does not exist.
 * A table is the form that cannot regress to that: `Record<CodingFailureClass, ResumeRule>` will not
 * compile if a class is added without a decision, and `coding-failure.test.ts` asserts the
 * denominator so a class cannot be added to the union and quietly omitted from the union type's
 * enforcement by a cast.
 *
 * **Retryable and resumable are not the same claim, and conflating them is how this ships wrong.**
 * `retryable: true` says an identical attempt could plausibly succeed. Resuming additionally
 * requires that repeating the attempt is SAFE and CHEAP — which is a property of who caused the
 * failure and what the run has already done, not of the transport that dropped.
 *
 * ── Why `DRIVER_`, not `CODING_` (#583 AC5)
 *
 * Nothing in this table is about coding. It reads a provider transport failure, a runner that went
 * away, a Cloudflare per-invocation ceiling and an isolate reset — every one of which is a fact
 * about the PLATFORM, and every one of which can kill an apply, a browser task, a pipeline or a
 * chat loop identically. Only its first consumer was the Pilot, and the name recorded the consumer
 * rather than the subject. #583 AC5 asks for a guard that this verdict has a reader on every
 * driver, and a decision function named after one of them is how the next driver ends up with a
 * second copy of the rule instead of a call to this one. `agent-loop.ts` is now the second caller.
 *
 * {@link classifyCodingFailure} and {@link CodingFailureClass} keep their names, deliberately: they
 * are a shared vocabulary whose name is a wart rather than a coupling, and renaming them would
 * churn ~60 references across two test files for no property. `workflows/driver-failure.test.ts`
 * measures the property that actually matters — that every driver REACHES a consumer — which no
 * amount of naming can establish.
 */
export const DRIVER_RESUME_POLICY: Record<CodingFailureClass, ResumeRule> = {
	// THE ONE. Our own deploy evicted a Durable Object out from under a run that was working, and
	// the owner experienced it as the agent dying for no reason. Terminating is not a viable policy
	// at the measured deploy cadence: a platform that ships seven API deploys in 48 minutes cannot
	// also treat a code update as a run-ending event and keep an hours-long agent usable. The
	// journal makes the retry close to free, which is what makes this decidable rather than a
	// trade-off.
	infra_transient: { resume: true, why: "a platform deploy reset the isolate — ours, not the owner's, and the workflow journal makes replaying it free" },
	// Retryable, and NOT resumable — the distinction this table exists to hold. Cloudflare has
	// ALREADY retried the attempt (that is what the class means, and `82739cb6` filing itself twice
	// eight minutes apart is the measurement). Re-dispatching the RUN is a different act: a fresh
	// run has no journal, so every act repeats, and two of the five recorded occurrences had already
	// pushed to `origin main`.
	workflow_internal: { resume: false, why: "Cloudflare already retried this attempt; re-dispatching the run would repeat acts it has already committed" },
	// #518's rule, unchanged and for its stated reason: every attempt costs the owner's credit. The
	// chat path can retry cheaply because it carries a stored round of completed tool results; the
	// Pilot has no such round (`resumableRound` is recorded false on every one of these), so a
	// "retry" here would re-drive the engine from where it stood, not resume from what it had.
	provider_stall: { resume: false, why: "each attempt spends the owner's credit and the Pilot carries no stored round to resume from (#518)" },
	provider_overrun: { resume: false, why: "deterministic — the reply was too long, so an identical attempt ends identically" },
	provider_credentials: { resume: false, why: "no key, a rejected key or an empty balance; only the owner can clear it" },
	provider_rate_limit: { resume: false, why: "the provider is throttling this key and wants a backoff, not an immediate replay" },
	provider_error: { resume: false, why: "the provider answered with an error we have not split out; retrying an unread error is a guess" },
	// The runner guard (#341) has already waited for this machine and concluded it is gone. Resuming
	// would re-enter a wait that already ran its full budget.
	runner_gone: { resume: false, why: "the machine was waited for and never came back — the guard has already spent that budget" },
	runner_unreachable: { resume: false, why: "the relay heals inside the runner guard; a death here means that wait was already exhausted" },
	// A per-invocation ceiling belongs to the INVOCATION, and a replay is a new one — but the run
	// would resume into the same unbounded poll that spent it. #523 fixed the cause; resuming here
	// would paper over its return.
	platform_ceiling: { resume: false, why: "a Cloudflare per-invocation limit; a replay would walk into the same ceiling rather than past it" },
	unknown: { resume: false, why: "nothing established what happened, and a resume on an unread failure is exactly the guess `retryable: null` refuses to make" },
};

export interface ResumeDecision extends ResumeRule {
	/** Interruptions this run has now been through, for the record and the bound. */
	attempts: number;
}

/**
 * Should this death resume the run instead of ending it?
 *
 * Three conditions, all necessary, and the order is the argument:
 *
 *  1. **The site that knows said a retry could work** — {@link isRetryableFailure}, the SAME
 *     predicate `autoResumableRoundOf` gates the chat path on. One rule, two drivers.
 *  2. **The class is safe and cheap to replay** — {@link DRIVER_RESUME_POLICY}. Retryable alone is
 *     not enough; `workflow_internal` is retryable and would repeat a merge.
 *  3. **The run can be BOUNDED** — the count is durable, because the resume works by replaying the
 *     journal and every in-memory counter replays with it. A run with no loop-run row cannot be
 *     counted, so it is not resumed: an unbounded resume is a worse failure than a terminated run.
 *
 * Called from the workflow's catch, where the alternative is the terminal teardown, so it MUST NOT
 * throw — a failure to decide degrades to "do not resume", which is the pre-#583 behaviour.
 *
 * ── Take a {@link CodingFailure}, and let the CALLER classify (#546)
 *
 * Both callers pass `classifyCodingFailure(e)` directly. `coding-session.ts` used to pass
 * {@link recordCodingFailure}'s return value instead, which made "is this run resumed?" depend on
 * whether an `error_log` INSERT succeeded — `recordCodingFailure` swallows its own failures by
 * design, and the caller's `.catch(() => null)` then landed on the `!failure` branch and ended a run
 * the platform could have replayed. The classifier is pure and total; the log write is neither, and
 * a durable control-flow decision must not be downstream of best-effort observability.
 */
export async function driverResumePlan(
	env: Env,
	failure: CodingFailure | null,
	runId: string | null,
): Promise<ResumeDecision> {
	const no = (why: string): ResumeDecision => ({ resume: false, why, attempts: 0 });
	if (!failure) return no("the failure could not be classified, so nothing established that a replay is safe");
	const rule = DRIVER_RESUME_POLICY[failure.class];
	if (!rule.resume) return { ...rule, attempts: 0 };
	if (!isRetryableFailure(failure)) return no(`${failure.class} is resumable in principle, but this one was not marked retryable`);
	if (!runId) return no("no loop-run row, so the resume could not be bounded — an unbounded replay is worse than stopping");
	const attempts = await countInterruption(env, runId).catch(() => Number.POSITIVE_INFINITY);
	if (attempts > MAX_PLATFORM_RESUMES) {
		return { resume: false, attempts, why: `interrupted ${attempts} times — past the ${MAX_PLATFORM_RESUMES} a deploy can plausibly explain, so this is a defect and not a deploy` };
	}
	return { ...rule, attempts };
}

/**
 * The moving parts of a run, carried so a death can name WHERE it happened.
 *
 * Every setter is called from code OUTSIDE `step.do`, which a Workflow replay re-executes while
 * replaying the journalled step results — the same property `pilotSteps` in the workflow relies on.
 * So a run resumed after an eviction still reports the phase and payload sizes it actually died at,
 * rather than the zeroes a step-journalled counter would give.
 *
 * ── This was a claim before it was a fact (#546)
 *
 * It held for {@link CodingRunProbe.at}, which the workflow calls when it NAMES a step. It did not
 * hold for {@link CodingRunProbe.saw} or {@link CodingRunProbe.drove}, which were called from
 * INSIDE the step callbacks — `probe.saw(pane.pane)` sat in `capture`, the body of the snapshot
 * step. A replay returns the journalled result without running the callback, so a resumed attempt
 * reported `paneChars: 0, instructionChars: 0` while faithfully reporting its phase.
 *
 * Production row `82739cb6`-B is exactly that: `0 / 0` at `s6-decide`, eight minutes after the
 * same run's first record. Left alone it reads as "the run died looking at an empty pane" — a
 * wrong diagnosis, which is worse than a missing one, and the next reader had this docblock
 * telling them to trust it.
 *
 * The workflow now calls both setters on the step's RESULT, outside the step, so the value crosses
 * the journal boundary and a replay re-measures it. `coding-session-probe.test.ts` asserts that by
 * replaying a journalled step, and `probe-outside-steps.test.ts` asserts no call site drifts back
 * inside one.
 */
export class CodingRunProbe {
	/** The durable step that was running: `s12-decide`, `s13-waitidle`, `start`, … */
	phase = "start";
	/** Terminal text last read — the bulk of what the next decide prompt carries. */
	paneChars = 0;
	/** The instruction last driven into the engine. Three deaths on ONE instruction is a payload
	 * question, and without its size the next occurrence is as opaque as those three. */
	instructionChars = 0;

	/** Name the step about to run AND return it, so a call site spends no extra line on this. */
	at(step: string): string {
		this.phase = step;
		return step;
	}

	saw(pane: unknown): void {
		if (typeof pane === "string") this.paneChars = pane.length;
	}

	drove(instruction: unknown): void {
		if (typeof instruction === "string") this.instructionChars = instruction.length;
	}
}

/**
 * What the platform DID about this death — the field that stops one run reading as several (#546).
 *
 * ── The defect
 *
 * Since #583 an `infra_transient` death is RESUMED: the driver rethrows, Cloudflare replays the
 * instance from its journal, and the run carries on. The record did not know that. Every death wrote
 * one row saying `coding run failed (<class>)`, so a run interrupted once and then killed filed two
 * of them and read as a run that died twice — measured on run `b9d9c051`, `infra_transient` at
 * 00:25:20 and `provider_stall` at 00:28:27 under one `runId`. Worse, the row CONTRADICTED the
 * driver's own next act: `coding-session.ts` posts "⏸ Interrupted by a platform update … nothing is
 * needed from you" to the chat immediately after writing "coding run failed" to the durable log.
 *
 * ── Why the row is kept rather than suppressed
 *
 * `agent-loop.ts`, the other {@link driverResumePlan} consumer, records its interruption as a
 * `loop.interrupted` EVENT and no error row at all. Matching that exactly would be the smaller
 * change and would lose the diagnostics that make an interruption countable — the class, the phase,
 * the elapsed time, the payload sizes and Cloudflare's own reference id, none of which the event
 * carries. #529 exists because a run that died with no durable record was the worse failure, and
 * "the platform interrupted this run" is precisely the thing worth counting. So the row stays and
 * stops lying: one run still files one DEATH, and its interruptions file as interruptions.
 */
export type CodingRunDisposition = "resumed" | "ended";

export interface CodingFailureRecord {
	err: unknown;
	userId: string;
	instanceId: string;
	sessionId: string;
	/**
	 * Did this death END the run, or was the run resumed past it? See {@link CodingRunDisposition}.
	 *
	 * Required, with no default. A default would be a guess about the caller's control flow, and the
	 * one caller that gets it wrong is exactly the one this field exists to fix — the workflow whose
	 * catch block wrote a death row and then resumed anyway.
	 */
	disposition: CodingRunDisposition;
	repo?: string | null;
	/** The machine the run was talking to. */
	node?: string | null;
	/** The loop-run id — the correlation key `agent_trace?trace_id=` is queried by. */
	runId?: string | null;
	/** The board card, when a supervisor delegated this run. */
	taskId?: string | null;
	/** Pilot steps driven, cumulative across handoff rounds. */
	steps: number;
	probe: CodingRunProbe;
	/** `runStartedAt` — journalled by the workflow, so the elapsed figure is the real one. */
	startedAt: number;
}

/**
 * File the death.
 *
 * `source: "coding:session"` on purpose. `list_errors` gets a value it can filter on, and
 * `logError`'s trace bridge splits at the colon, so the mirrored `agent_trace` row lands under
 * `coding` beside the acts and authority events of the same run instead of inventing a source
 * nothing else uses. `traceId` is the loop-run id when there is one — the same key
 * `recordEngineActs` stamps — so a dead run joins to the turn that started it; the session id is
 * the fallback, because a chat-initiated `start_work` has no run id and still has to be findable.
 *
 * Never throws (`logError` swallows), and returns the classification so the caller can use it
 * without classifying twice.
 */
export async function recordCodingFailure(env: Env, r: CodingFailureRecord): Promise<CodingFailure> {
	const f = classifyCodingFailure(r.err);
	const raw = r.err instanceof Error ? r.err.message : String(r.err ?? "");
	// Classify on the RAW text, collapse on the stable text (#546). The order matters: the
	// reference is stripped only after the class has been read off the message it is embedded in.
	const { message, reference } = splitCfReference(raw);
	const resumed = r.disposition === "resumed";
	await logError(env, {
		source: "coding:session",
		userId: r.userId,
		// A row the platform is ACTIVELY RECOVERING FROM is never a bug, whatever its class says.
		// `infra_transient` is already `warn`, so this changes nothing today — and that is why it is
		// written as a rule rather than left to the class table. `DRIVER_RESUME_POLICY` is a table
		// somebody will add a resumable class to, and the next one need not be in {@link EXPLAINED}.
		level: resumed ? "warn" : codingFailureLevel(f.class),
		// The VERB is the fix. Before it, the row said the run failed while the same catch block's
		// next act posted "⏸ Interrupted by a platform update … nothing is needed from you" into the
		// owner's chat — two durable accounts of one event, disagreeing, with the log the wrong one.
		message: `coding run ${resumed ? "interrupted" : "failed"} (${f.class}) at ${r.probe.phase} after ${r.steps} steps${resumed ? ", resumed" : ""}: ${message}`,
		context: {
			// What the platform did about it, so a reader counting DEATHS gets one per run even when
			// the run filed several rows on its way there (#546).
			disposition: r.disposition,
			instanceId: r.instanceId,
			traceId: r.runId ?? r.sessionId,
			sessionId: r.sessionId,
			runId: r.runId ?? null,
			taskId: r.taskId ?? null,
			repo: r.repo ?? null,
			node: r.node ?? null,
			failureClass: f.class,
			retryable: f.retryable,
			upstreamStatus: f.upstreamStatus,
			// Cloudflare's support handle, out of the headline so the row can collapse and into a
			// field so it survives. Omitted entirely when there is none, rather than written as null:
			// a key that is present on every row is one more thing to read past.
			...(reference ? { cfReference: reference } : {}),
			phase: r.probe.phase,
			steps: r.steps,
			instructionChars: r.probe.instructionChars,
			paneChars: r.probe.paneChars,
			elapsedMs: Math.max(0, Date.now() - r.startedAt),
			// The Pilot has no `thinkWithAutoResume` (#518) — this is expected to be false, and
			// recording it is what makes that an observation rather than an assumption.
			resumableRound: resumableRoundOf(r.err) !== null,
			stack: r.err instanceof Error ? String(r.err.stack || "").slice(0, 1500) : undefined,
		},
	});
	return f;
}
