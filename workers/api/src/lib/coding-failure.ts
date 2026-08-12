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
import { logError } from "./error-log.js";
import { resumableRoundOf } from "./resumable-round.js";
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
]);

export function codingFailureLevel(cls: CodingFailureClass): "error" | "warn" {
	return EXPLAINED.has(cls) ? "warn" : "error";
}

/**
 * The moving parts of a run, carried so a death can name WHERE it happened.
 *
 * Everything here is set from code OUTSIDE `step.do`, which a Workflow replay re-executes while
 * replaying the journalled step results — the same property `pilotSteps` in the workflow relies on.
 * So a run resumed after an eviction still reports the phase and payload sizes it actually died at,
 * rather than the zeroes a step-journalled counter would give.
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

export interface CodingFailureRecord {
	err: unknown;
	userId: string;
	instanceId: string;
	sessionId: string;
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
	const message = r.err instanceof Error ? r.err.message : String(r.err ?? "");
	await logError(env, {
		source: "coding:session",
		userId: r.userId,
		level: codingFailureLevel(f.class),
		status: f.upstreamStatus ?? undefined,
		message: `coding run failed (${f.class}) at ${r.probe.phase} after ${r.steps} steps: ${message}`,
		context: {
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
