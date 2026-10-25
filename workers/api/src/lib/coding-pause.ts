// What a Pilot run does when it cannot proceed RIGHT NOW (#541).
//
// Two things stop a run without ending it, and until this module they were one thing:
//
//   * A HUMAN HANDOFF — an interactive login, a menu the headless engine cannot answer, a widget
//     it failed at. Somebody has to take the session over. Fifteen minutes is the right bound: it
//     is how long a question may go unanswered before "waiting on you" is the honest report.
//   * The ENGINE'S OWN USAGE LIMIT — the CLI's subscription window is spent and reopens at a stated
//     time. Nobody can resolve that by taking over. Fifteen minutes is the WRONG bound, and three
//     production runs died 41 minutes early proving it (see coding-wait.ts for the measurements).
//
// Collapsing them cost the runs. Separating them is what this file is: one entry point,
// `resolvePause`, that reads the loop's verdict and either resumes the run or hands back the
// terminal result — with the two waits sized against the two different things being waited for.
//
// EXTRACTED from `workflows/coding-session.ts`, which was 799 lines against an 800-line ratchet, and
// which is where this logic had no business living anyway: "how long may a run wait, and for what"
// is a rule, and rules that sit inside a Workflow can only be tested by running one. Effects are
// INJECTED ({@link PauseDeps}) exactly as `makeRunnerGuard` injects its probe/sleep/announce/tick,
// so the whole pause machine unit-tests with no D1, no relay and no Workflow.
import {
	ENGINE_WAIT_TICK_MS,
	engineResumeMessage,
	engineResumeNote,
	engineWaitExhausted,
	enginePauseMessage,
	planEngineWait,
	planTransientWait,
	type EngineWaitState,
} from "./coding-wait.js";
import type { LoopStopReason } from "./agent-loop.js";
import { clipMarked } from "./clip-marked.js";
import { ASK_QUESTION_FULL_MAX, type AskPart } from "./coding-ask.js";
import type { CapSummary, CodingOutcome, CodingResult } from "./coding-loop.js";
import { type DeepLink, deepLinkFor } from "./console-links.js";
import { codingCardId } from "./coding-board.js";
import type { CodingQuestionIssue } from "./coding-question-source.js";
import { DECISION_PARK_MS, MAX_PARK_WAKES } from "./coding-park.js";

/** Max polls for a human to resolve a stuck/needs-input handoff. 180 × 5s = 15 min. */
export const HANDOFF_WAIT_POLLS = 180;
export const HANDOFF_POLL_MS = 5_000;

/**
 * How long the run waits for a person before it GIVES UP — the same 15 minutes, as one number.
 *
 * Derived, not retyped: the announcement, the expiry sentence and the published `waiting_until` all
 * state this bound, and three hand-written "15 minutes" would be three things to keep in step with
 * a poll count. That is the drift #596 is about, one level down.
 */
export const HANDOFF_GIVE_UP_MS = HANDOFF_WAIT_POLLS * HANDOFF_POLL_MS;

/**
 * Keep the run's claims alive every this many handoff polls (60s).
 *
 * The handoff wait is 15 minutes and `STALE_DRIVER_MS` is 15 minutes, so a run parked in a handoff
 * was one scheduling hiccup from expiring its OWN single-flight claim and letting a second Pilot
 * take the session out from under it — the exact collision the claim exists to prevent. The runner
 * guard already heartbeats through its own `tick`; this wait never did.
 */
export const HANDOFF_TICK_EVERY = 12;

/** The run a handoff is about: its board task when it has one (#899), else its coding session (#894). */
function handoffLink(deps: Pick<PauseDeps, "instanceId" | "taskId" | "sessionId">): DeepLink {
	if (deps.taskId) return deepLinkFor({ kind: "task", instanceId: deps.instanceId, taskId: deps.taskId });
	return deps.sessionId ? deepLinkFor({ kind: "coding-session", instanceId: deps.instanceId, sessionId: deps.sessionId }) : deepLinkFor({ kind: "coding-tab", instanceId: deps.instanceId });
}

export interface PauseDeps {
	/** Repo label, for the notification body. */
	repo: string;
	/** The run's trusted linked issue, if any. A read failure must not block a question. */
	sourceIssue?: () => Promise<CodingQuestionIssue | null>;
	/** The owner's IANA zone, or undefined. Rendered as UTC, out loud, when unset. */
	timeZone?: string;
	/** The instance ID, for building deep-links to the run (#899). */
	instanceId: string;
	/** The board task ID, for deep-linking to the stuck run (#899). When absent, falls back to the coding session. */
	taskId?: string;
	/**
	 * The session the run drives (#894) — what the fallback above links to. Without it the fallback was
	 * the Coding tab's repo LIST, so a "Coder needs you" with no board task opened no particular run.
	 */
	sessionId?: string;
	/** Open the console takeover on the runner. */
	takeover: (label: string, reason: "stuck" | "needs_input") => Promise<void>;
	/**
	 * Publish a QUESTION (#960) — a `needs_input` pause: the `agent.needs_input` event on the run's
	 * card (what lights up the console's answer box) and the `decision` park with the ask stored on
	 * the run (what coding_loop_status, the fleet and the board read). Optional so a test or a caller
	 * with nothing to publish to still pauses; the workflow always provides it.
	 */
	ask?: (ask: { question: string; options: string[]; why: string; field: string; taskId: string; fullQuestion?: string; parts?: AskPart[]; issue?: CodingQuestionIssue }) => Promise<unknown>;
	/** Has the human resolved it, and with what value? */
	takeoverStatus: () => Promise<{ resolved: boolean; value?: string }>;
	/** Close the takeover once it is resolved. */
	endTakeover: () => Promise<void>;
	/**
	 * Record that this run consumed the question's answer (#1075: `applied_at` / `applied_run_id`), so a
	 * second answer is reported "already applied" rather than taken for a pending one. Best-effort.
	 */
	applied?: () => Promise<void>;
	/**
	 * Park on a captured QUESTION at zero compute instead of polling for it (#1076). Absent — a run
	 * with no loop-run row, which nothing could wake — falls back to the live poll below.
	 */
	park?: {
		/**
		 * Record the park (its instance and its `waiting_until`), drain and stop the engine PROCESS, and
		 * release the checkout when its work could be set aside (#1077). `announce` says what happened to
		 * the checkout; `onStop` is what an ending without a resume must tell the owner about their work.
		 */
		begin: (questionId: string, until: number, opts?: { keepCheckout?: boolean }) => Promise<{ announce?: string; onStop?: string } | undefined>;
		/** Wait for the question's event — no step runs while it waits. False when the wait timed out. */
		wait: (questionId: string, k: number, timeoutMs: number) => Promise<boolean>;
		/**
		 * Take the checkout back, bring the engine back, re-sync onto the current upstream and put the
		 * set-aside work back (#1077, #1078). `line` says whether the engine continued its conversation;
		 * `moved` is what changed on the base while it was parked. `busy`: the checkout is somebody
		 * else's — keep waiting. `blocked`: the base or the work could not be brought back; nothing was changed.
		 */
		resumeEngine: (parkedForMs: number) => Promise<{ line: string; moved: string | null } | { busy: string } | { blocked: string }>;
	};
	/**
	 * Has the re-auth relay signed the engine in at or after `since` (#881)? What a run parked on
	 * `needs_reauth` polls — the relay is driven by the owner from another device, so this record is
	 * the only thing the two sides share.
	 */
	reauthCompletedSince: (since: number) => Promise<boolean>;
	/**
	 * Stop the engine and launch it again, with its env resolved FRESH (#881). A signed-in engine has
	 * to be a NEW process: a live headless session keeps the env it was spawned with — a replaced
	 * Claude token would not reach it — and a dead one still shows the old "Not logged in" line,
	 * which the loop would read as a fresh sign-in block and park on again. Throws when the stop
	 * failed, in which case nothing was relaunched (two engines on one checkout is worse).
	 */
	restartEngine: () => Promise<void>;
	/** A DURABLE sleep — `step.sleep`, so a six-hour park survives the workflow being evicted. */
	sleep: (label: string, ms: number) => Promise<void>;
	/**
	 * Push notification to the owner. `alert` outranks a "Coder" mute — set only for a handoff,
	 * which STOPS the engine until someone answers. A usage-limit park needs nothing from anyone
	 * and must not ping like a question, or people learn to stop reading these.
	 */
	/** `type` (#1025): a question is a `coder_question` notification — the type its later brain decision, escalation and close use too. */
	notify: (title: string, body: string, key: string, alert: boolean, url?: DeepLink, type?: "coder_question") => Promise<void>;
	/** One line into the owner's chat thread. A pause nobody can see looks like a hang (#252). */
	announce: (message: string) => Promise<void>;
	/**
	 * Move the run's board card (#553).
	 *
	 * The notification and the chat line are both PUSHES — they land once, in a tray or a scroll,
	 * and are gone. The board is the durable surface, and it is the one with a column named "Needs
	 * you". While three runs sat parked here for 15 minutes each it stayed empty: `notifyUser` was
	 * called and `pushed_at` was set on every row (verified), so the information existed and was
	 * nowhere anybody would look for it later. #349 is the same defect on apply and browser-task.
	 *
	 * Injected like every other effect in this module, so the whole pause machine still tests with
	 * no D1, no relay and no Workflow.
	 */
	card: (status: "needs_human" | "running") => Promise<void>;
	/**
	 * Heartbeat the claims a parked run holds, and report whether it should still be running.
	 *
	 * Returns FALSE when the owner has asked the run to stop. Folding cancellation into the same
	 * call is deliberate: a wait that heartbeats but cannot be cancelled is a run the Stop button
	 * silently does not reach, which is how a six-hour park would otherwise become unstoppable.
	 *
	 * `park.until` is WHEN this park's clock runs out, and it is an argument because this module is
	 * the only place that knows it (#591). `planEngineWait` computes `until: now + ms` and it was
	 * consumed for the chat sentence and then dropped: `agent_loop_runs.waiting_until` had NO
	 * production writer, and read null on 89 of 89 runs — including one parked 6h51m by its own wall
	 * clock. "Parked, resuming 16:00" and "parked, indefinitely" are different decisions for an
	 * owner, and the platform knew the first and reported the second.
	 *
	 * It is the instant, NOT what the instant means: both waits below pass one and they mean
	 * opposite things (a resume, and a give-up). The kind is entailed by the park REASON, which the
	 * caller already supplies, and is rendered from `work-report.ts`'s `PARKS` — so nothing here has
	 * to describe it and nothing downstream has to guess (#596).
	 *
	 * Still optional, because a park can have no knowable end: `platform_interrupt` is parked until
	 * Cloudflare replays a journal, and inventing an instant for that would be worse than omitting it.
	 */
	tick: (park?: { until?: number | null }) => Promise<boolean>;
	now: () => number;
	/**
	 * The current instant, JOURNALLED under `label` (#1362): the same value on every replay. A park plans its length from
	 * the clock, and the workflow replays its body after every `step.sleep` — planned against a live `now()`, each replay
	 * planned again later, and a reset the CLI printed as a clock time ("try again at 4:12 PM") read as tomorrow after the
	 * last sleep and was refused, ending the run as the limit lifted. Optional for callers with no journal (tests).
	 */
	stamp?: (label: string) => Promise<number>;
	/**
	 * #1236: the round's step cap and the account's ceiling, for a run that reaches its cap. The owner is
	 * asked to approve more iterations (the cap again, at most the ceiling) instead of the run failing.
	 */
	iterations?: { cap: number; ceiling: number };
}

/**
 * How long a QUESTION may wait (#1025), as the question's own record says: `waitMs` is when the run
 * stops waiting, `humanMs` how long the owner has before the coder brain may decide. Absent → the
 * plain 15-minute handoff. With the brain on, the run stays parked while the minute sweep owns the
 * timers, and the answer still arrives the one way every answer does: the takeover resolving.
 */
export interface QuestionWait {
	waitMs: number;
	humanMs: number;
	brain: boolean;
	/** The `coder_questions` row (#1075) — what a park waits on and reads its answer from (#1076). */
	questionId?: string;
}

/** What `ask` returned, when it is a {@link QuestionWait} — a publish-only `ask` returns nothing. */
function asQuestionWait(v: unknown): QuestionWait | null {
	const w = v as Partial<QuestionWait> | null | undefined;
	return w && typeof w.waitMs === "number" && typeof w.humanMs === "number" ? { waitMs: w.waitMs, humanMs: w.humanMs, brain: w.brain === true, ...(typeof w.questionId === "string" ? { questionId: w.questionId } : {}) } : null;
}

/** Past the first 15 minutes a brain-held question is polled once a minute — the sweep's own cadence. */
export const BRAIN_WAIT_POLL_MS = 60_000;

export type PauseVerdict =
	| { resume: true; userHint?: string; resumeNote?: string; ownerTurn?: boolean; /** The owner's answer as given (#1236). */ answer?: string; /** #1236: steps the owner granted for the next round. */ grantSteps?: number }
	| { resume: false; result: CodingResult; stopReason?: LoopStopReason };

/**
 * Read one round's verdict: resume the run, or hand back the result it ends on.
 *
 * `state` is MUTATED — it belongs to the run, not to the round, because "how long may this run
 * wait" is a property of the run, the same reasoning `makeRunnerGuard` holds its budget by.
 */
export async function resolvePause(
	deps: PauseDeps,
	input: { round: number; result: CodingResult; state: EngineWaitState },
): Promise<PauseVerdict> {
	const { result } = input;
	if (result.outcome === "waiting") return waitForEngineReset(deps, input);
	if (result.outcome === "needs_reauth") return waitForSignIn(deps, input);
	if (result.outcome === "max_steps") return waitForIterationApproval(deps, input);
	if (result.outcome !== "stuck" && result.outcome !== "needs_input") return { resume: false, result };
	return waitForHuman(deps, input);
}

/**
 * The card a question is answered on (#960): the run's delegation task when it has one, else its
 * session card — every coding session has one (`csess-<id>`), so an owner-started run is covered.
 */
export function askCardId(deps: Pick<PauseDeps, "taskId" | "sessionId">): string | null {
	return deps.taskId ?? (deps.sessionId ? codingCardId(deps.sessionId) : null);
}

async function waitForHuman(deps: PauseDeps, input: { round: number; result: CodingResult }, opts: { keepCheckout?: boolean } = {}): Promise<PauseVerdict> {
	const { result, round } = input;
	const reason = result.outcome === "needs_input" ? "needs_input" : "stuck";
	// `||`, not `??` (#1234): a no-action decision reports `detail: decision.thought`, which can be "",
	// and an empty label is the blank question the owner was sent.
	const label = (reason === "needs_input" ? result.fieldNeeded?.trim() || "a value" : result.detail?.trim()) || "this step";
	const options = reason === "needs_input" ? (result.options ?? []) : [];
	// A stuck run asks too (#1234). It used to wait as a bare takeover — no question, no answer box —
	// so a repetition-guard stop parked "waiting on a human" with `waitingAsk` null, the owner's typed
	// answer fell through to an older question already applied, and nothing could resume it. Now every
	// wait on a person is a question on the card: answerable from a conversation, parked at zero compute
	// like any other, and decidable by the brain under the same rules.
	const cardId = askCardId(deps);
	const issue = await deps.sourceIssue?.().catch(() => null) ?? null;

	await deps.takeover(label, reason);
	// A QUESTION is published as one (#960): its event on the card and its park on the run, before the
	// pushes below point anyone at it. Best-effort for the same reason the card is — a lost event is a
	// visibility bug; failing the pause is a work bug.
	const wait = cardId && deps.ask ? asQuestionWait(await deps.ask({ question: label, options, why: reason === "needs_input" ? (result.detail ?? "") : "", field: result.fieldNeeded ?? label, taskId: cardId, ...(result.fullQuestion ? { fullQuestion: result.fullQuestion } : {}), ...(result.parts?.length ? { parts: result.parts } : {}), ...(issue ? { issue } : {}) }).catch(() => undefined)) : null;
	const giveUpMs = Math.max(HANDOFF_GIVE_UP_MS, wait?.waitMs ?? 0);
	const minutes = Math.round((wait?.brain ? wait.humanMs : giveUpMs) / 60_000);
	// #1076: a captured question PARKS — no compute, no deadline worth racing — rather than polling.
	const parkOn = deps.park && wait?.questionId ? wait.questionId : null;
	const anyTime = "Answer any time: the run is parked, using no compute, and continues from where it stopped.";
	const clock = wait?.brain
		? `You have ${minutes} minutes to answer before the coder brain may decide (only if the issue already settles it).${parkOn ? ` ${anyTime}` : ""}`
		: parkOn
			? anyTime
			: `You have ${minutes} minutes to respond before the run gives up.`;
	// The board FIRST, before the two pushes. It is the surface that persists, so if anything after
	// this throws, the durable record still says the run is waiting on somebody — rather than the
	// state that produced #553, where the notification fired and the board said everything was fine.
	await deps.card("needs_human");
	// The Engine is stopped until someone answers — `alert`, so muting "Coder" silences the
	// finished/stopped updates and never this.
	// A question opens the card its answer box is on; a takeover opens the run (#894).
	const notificationUrl = cardId ? deepLinkFor({ kind: "task", instanceId: deps.instanceId, taskId: cardId }) : handoffLink(deps);
	const offered = options.length ? ` Options: ${options.join(" | ")}.` : "";
	const source = issue ? `${issue.repo}#${issue.number} — ${issue.title}. ${issue.url}` : deps.repo;
	const context = issue?.summary ? ` Context: ${clipMarked(issue.summary, 180, { within: true })}.` : "";
	const why = result.detail?.trim() ? ` Why: ${clipMarked(result.detail.trim(), 180, { within: true })}.` : "";
	const body = `${source}: ${label}.${why}${context}${offered} ${clock}`;
	const title = reason === "needs_input" ? "Coder has a question" : "Coder needs you";
	const icon = reason === "needs_input" ? "❓" : "🙋";
	await deps.notify(`${icon} ${title}`, body, `coding-handoff:${reason}:${round}`, true, notificationUrl, "coder_question");
	// …AND in the thread the run was started from (#541 item d). A runner disconnect has always been
	// announced in chat; a handoff never was, so the conversation the owner started the run from said
	// nothing at all while the run waited on him, and then reported that it had failed.
	// The deadline is said OUT LOUD (#596 AC2). It was computable from the first line of this
	// function and was never published anywhere, so the one wait an owner can still beat was the one
	// that never stated its clock — while the usage-limit park, which needs nothing from anybody,
	// announced its resume time in this same thread. "Take over" without "by when" is why three runs
	// sat here for the full fifteen minutes and then reported that they had been waiting on someone.
	await deps.announce(
		`${icon} **${title}** — ${parkOn ? "parked" : "paused"} on ${issue ? `[${issue.repo}#${issue.number} — ${issue.title}](${issue.url})` : deps.repo}: ${label}${result.detail?.trim() ? `\n\nWhy: ${result.detail.trim()}` : ""}${issue?.summary ? `\n\nIssue context: ${issue.summary}` : ""}${offered ? `\n\n${offered.trim()}` : ""}\n\nAnswer it on the run's card${cardId ? ` (\`${cardId}\`)` : ""} or with answer_instance_input — no need to take the session over. The run continues from where it stopped. ${wait?.brain || parkOn ? clock : `If nobody answers within ${minutes} minutes it stops and reports that it is waiting on you.`}`,
	);

	if (parkOn && deps.park) return parkOnQuestion(deps, deps.park, { result, label, options, questionId: parkOn, keepCheckout: opts.keepCheckout });

	let resolved = false;
	let value: string | undefined;
	// The first 15 minutes at 5s, then (a brain-held question only) once a minute up to its bound —
	// the sweep acts once a minute, and a long wait at 5s would be a thousand journalled sleeps.
	const extraPolls = Math.ceil((giveUpMs - HANDOFF_GIVE_UP_MS) / BRAIN_WAIT_POLL_MS);
	const totalPolls = HANDOFF_WAIT_POLLS + extraPolls;
	const remainingMs = (poll: number) => (poll < HANDOFF_WAIT_POLLS ? (HANDOFF_WAIT_POLLS - poll - 1) * HANDOFF_POLL_MS + extraPolls * BRAIN_WAIT_POLL_MS : (totalPolls - poll - 1) * BRAIN_WAIT_POLL_MS);
	for (let poll = 0; poll < totalPolls && !resolved; poll++) {
		await deps.sleep(`wait-${round}-${poll}`, poll < HANDOFF_WAIT_POLLS ? HANDOFF_POLL_MS : BRAIN_WAIT_POLL_MS);
		// The park's end, published (#596). It used to be withheld: `waiting_until` was rendered
		// unconditionally as "expected to resume in …", so a give-up time under it would have told an
		// owner to sit and wait for a run that was about to stop waiting for THEM. The renderer now
		// reads the KIND of deadline off the park reason (`work-report.ts`'s `PARKS`), so the honest
		// move flips: withholding it hides the only deadline the reader can still act on.
		//
		// Computed from the polls REMAINING rather than from a deadline captured before the loop, so
		// it names the same absolute instant on every tick and stays right after a Workflow replay —
		// where the loop restarts and a captured deadline would have slid forward by a whole wait.
		const until = deps.now() + remainingMs(poll);
		if ((poll >= HANDOFF_WAIT_POLLS || poll % HANDOFF_TICK_EVERY === 0) && !(await deps.tick({ until }))) {
			return { resume: false, result: { ...result, outcome: "cancelled", detail: "Stopped by you." } };
		}
		const status = await deps.takeoverStatus().catch(() => ({ resolved: false }) as { resolved: boolean; value?: string });
		resolved = status.resolved;
		if (resolved) value = status.value;
	}

	if (!resolved) {
		// NOT `failed` any more (#541 item a). The run is waiting on the OWNER — it is the one state
		// where "needs you" is literally true — and reporting it as a failure is what had him
		// re-typing Retry on runs that were never broken. The outcome is left as `stuck` /
		// `needs_input`, which `stopReasonFor` maps to `escalated`, which `statusFor` maps to
		// `needs_human`: the board column that was empty while these runs died.
		return {
			resume: false,
			result: {
				...result,
				detail: `Waiting on you: ${label}. ${reason === "needs_input" ? "Nobody answered" : "Nobody took the session over"} within ${Math.round(giveUpMs / 60_000)} minutes, so the run stopped here.`,
			},
		};
	}

	await deps.applied?.().catch(() => undefined);
	await deps.endTakeover();
	// Somebody answered — the run is working again, so it leaves "Needs you". Not left for the
	// terminal write: a run can take several handoffs across its 12 rounds, and a card that stayed
	// in "Needs you" through the working stretches would ask for attention it does not need, which
	// is how a column stops being read.
	await deps.card("running");
	return {
		resume: true,
		ownerTurn: true,
		userHint: answerHint(result, options, value),
		answer: value,
	};
}

/** What the run is told when the owner answered: the answer, as one owner turn. */
function answerHint(result: CodingResult, options: string[], value: string | undefined): string | undefined {
	if (!value) return undefined;
	if (result.outcome === "stuck") return `The owner answered your request for help ("${result.detail?.trim() || "this step"}"): ${value}`;
	if (!result.fieldNeeded) return undefined;
	return options.length ? `The owner answered your question "${result.fieldNeeded}": ${value}` : `${result.fieldNeeded}: ${value}`;
}

/**
 * Park on the question at ZERO compute (#1076): record the park, stop the engine process, and wait
 * for the question's event. No sleep loop, no runner poll, no heartbeat — and nothing ticks, so the
 * park publishes `waiting_until` (its 30-day end), which is what keeps the run sweeper and
 * `runHealth` calling it waiting rather than dead.
 *
 * Every wake re-reads D1: the cancel flag first (so `stop_work` reaches a parked run, #790), then the
 * answer from the question's row (#1075). A wake that finds neither — a duplicate event, a backstop
 * re-send racing an answer this run already applied — waits again. The answer resumes THIS run: the
 * same run id, the same Workflow instance, its timeline and its `learned` notes where they were.
 */
async function parkOnQuestion(
	deps: PauseDeps,
	park: NonNullable<PauseDeps["park"]>,
	input: { result: CodingResult; label: string; options: string[]; questionId: string; keepCheckout?: boolean },
): Promise<PauseVerdict> {
	const { result, label, options, questionId } = input;
	const parkedAt = deps.now();
	const until = parkedAt + DECISION_PARK_MS;
	const parked = (await park.begin(questionId, until, input.keepCheckout ? { keepCheckout: true } : undefined)) ?? {};
	if (parked.announce) await deps.announce(`⏸ ${parked.announce}`);
	const onStop = parked.onStop ? ` ${parked.onStop}` : "";
	let idle = 0;
	let saidBusy = false;
	for (let k = 0; idle < MAX_PARK_WAKES; k++) {
		const woke = await park.wait(questionId, k, Math.max(1_000, until - deps.now()));
		if (!(await deps.tick({ until }))) return { resume: false, result: { ...result, outcome: "cancelled", detail: `Stopped by you while it was parked on your answer.${onStop}` } };
		if (!woke) break;
		const status = await deps.takeoverStatus().catch(() => ({ resolved: false }) as { resolved: boolean; value?: string });
		if (!status.resolved) {
			idle++;
			continue;
		}
		// A resume that failed half-way is not a resume: keep waiting (the backstop retries) rather than apply the answer on an unchecked base.
		const engine = await park.resumeEngine(deps.now() - parkedAt).catch((e: unknown) => ({ busy: `the resume could not complete just now (${e instanceof Error ? e.message : String(e)})` }));
		if ("busy" in engine) {
			// The answer is in and the checkout is somebody else's right now (#1077): wait for it. The holder's end wakes this run first.
			if (!saidBusy) await deps.announce(`⏳ **Your answer is in** — ${deps.repo} is busy (${engine.busy}), so this run resumes as soon as it is free.`);
			saidBusy = true;
			continue;
		}
		if ("blocked" in engine) {
			return { resume: false, result: { ...result, outcome: "stuck", detail: `Your answer is in, but the run could not continue: ${engine.blocked}` } };
		}
		await deps.applied?.().catch(() => undefined);
		await deps.endTakeover().catch(() => undefined);
		await deps.card("running");
		await deps.announce(`▶️ **Resumed with your answer** on ${deps.repo}: ${label}. ${engine.line}${engine.moved ? `\n\n${engine.moved}` : ""}`);
		// What moved on the base rides the SAME turn as the answer (#1078): the answer was given against the state before it.
		return { resume: true, ownerTurn: true, userHint: answerHint(result, options, status.value), answer: status.value, ...(engine.moved ? { resumeNote: engine.moved } : {}) };
	}
	return {
		resume: false,
		stopReason: "decision",
		result: { ...result, detail: `Waiting on you: ${label}. Nobody answered within ${Math.round(DECISION_PARK_MS / 86_400_000)} days, so the run stopped here. An answer is still recorded on the question; continue the run once it is in.${onStop}` },
	};
}

// ── #1236: the iteration cap asks instead of failing ───────────────────────────────────────────

export const DENY_ITERATIONS = "Deny — stop the run here";
export const approveIterationsOption = (n: number) => `Approve ${n} more iterations`;

/**
 * What the owner's answer to an iteration-cap question means. A deny word stops the run; a number
 * grants that many (1 to the ceiling); anything else — "approve", "yes", a bare Resume, or an
 * instruction — grants the requested amount, and text that is not just a yes rides along as an owner turn.
 */
export function readIterationAnswer(value: string | undefined, requested: number, ceiling: number): { approved: false } | { approved: true; steps: number; note: string | null } {
	const text = (value ?? "").trim();
	if (/^\s*(deny|denied|stop|no|cancel|reject)\b/i.test(text) || text === DENY_ITERATIONS) return { approved: false };
	const n = /\b(\d{1,4})\b/.exec(text);
	const steps = n ? Math.min(Math.max(Number(n[1]), 1), ceiling) : requested;
	const bare = !text || text === approveIterationsOption(requested) || /^(approve[ds]?|yes|ok(ay)?|continue|go( on)?|resume)\b[\s\d.!]*(more )?(iterations?|steps?)?[.!]*$/i.test(text);
	return { approved: true, steps, note: bare ? null : text };
}

/**
 * The iteration-cap report, in full (#1261): what the brain did, its exact blocker, its plan — or
 * that it plainly has none — and the steps it is asking for with its own reason. Bounded like any
 * other uncut ask rather than invented afresh — see `coding-ask.ts`'s `ASK_QUESTION_FULL_MAX`.
 */
export function renderCapSummary(s: CapSummary): string {
	const plan = s.plan.trim() || "No concrete plan: it did not state one.";
	const text = [
		`What it did: ${s.did.trim() || "(not stated)"}`,
		`Blocker: ${s.blocker.trim() || "(not stated)"}`,
		`Plan: ${plan}`,
		`Asking for ${s.steps > 0 ? s.steps : "more"} more steps — ${s.reason.trim() || "(no reason given)"}`,
	].join("\n\n");
	return clipMarked(text, ASK_QUESTION_FULL_MAX, { within: true });
}

/**
 * The run reached its step cap. Before #1236 that ended it `max_iterations` (`failed`), and the work
 * in its session waited for a new run to rediscover it. Now it asks: the question goes on the run's
 * card like any other (answer_instance_input or the card's buttons), parks at zero compute, and —
 * unlike a question — KEEPS its checkout, so the working tree stays exactly as the run left it.
 * Approve resumes the SAME run in the same session with the steps granted; deny stops it with no
 * further steps; no answer ends it the way every human wait ends, continuable, never `failed`.
 *
 * #1261: the step count offered is the BRAIN'S OWN, not a platform default — `runCodingLoop` asks it
 * for one once it has no steps left, and `capSummary` carries what it said. Absent (an older run, or
 * a cap round the brain did not answer) falls back to the previous fixed-cap behaviour untouched.
 */
async function waitForIterationApproval(deps: PauseDeps, input: { round: number; result: CodingResult }): Promise<PauseVerdict> {
	const { result, round } = input;
	const cap = deps.iterations?.cap ?? result.steps;
	const ceiling = Math.max(1, deps.iterations?.ceiling ?? cap);
	const fallback = Math.min(Math.max(cap, 1), ceiling);
	const s = result.capSummary;
	const requested = s && s.steps > 0 ? Math.min(Math.max(Math.round(s.steps), 1), ceiling) : fallback;
	const report = s
		? renderCapSummary(s)
		: (() => {
				const recent = (result.transcript ?? []).slice(-3).join(" · ");
				return recent ? `Its last steps: ${clipMarked(recent, ASK_QUESTION_FULL_MAX, { within: true })}` : "";
			})();
	const question = `This run reached its cap of ${result.steps} iterations without finishing. Approve ${requested} more to let the same run continue in the same session (the working tree is untouched), or deny to stop it here.`;
	const asked: CodingResult = {
		...result,
		outcome: "needs_input",
		fieldNeeded: question,
		options: [approveIterationsOption(requested), DENY_ITERATIONS],
		detail: report || undefined,
		// The full report rides as the uncut ask (#1129's mechanism) so the GitHub comment and the
		// console/MCP `fullQuestion` carry it whole — `question` above stays phone-sized.
		...(report ? { fullQuestion: `${question}\n\n${report}` } : {}),
	};
	const verdict = await waitForHuman(deps, { round, result: asked }, { keepCheckout: true });
	if (!verdict.resume) return verdict;
	const read = readIterationAnswer(verdict.answer, requested, ceiling);
	if (!read.approved) {
		return { resume: false, stopReason: "cancelled", result: { ...result, outcome: "cancelled", detail: `Stopped by you at the iteration cap (${result.steps} iterations): you denied more, so it took no further steps. Its work is in the session as it was.` } };
	}
	await deps.announce(`▶️ **${read.steps} more iterations approved** on ${deps.repo} — the same run continues.`);
	return {
		resume: true,
		ownerTurn: true,
		grantSteps: read.steps,
		userHint: `The owner approved ${read.steps} more iterations after you reached your cap. Continue the objective from exactly where you are — the working tree is as you left it.${read.note ? ` They added: ${read.note}` : ""}`,
	};
}

async function waitForEngineReset(
	deps: PauseDeps,
	input: { round: number; result: CodingResult; state: EngineWaitState },
): Promise<PauseVerdict> {
	const { result, round, state } = input;
	// A provider failing transiently parks on its own short ladder and never spends the usage-limit budget (#1344). Out of
	// waits it ends as a continuable engine error saying so — not as "the CLI's usage limit", which it never was.
	const transient = result.waitKind === "transient";
	const now = deps.stamp ? await deps.stamp(`ewait-${round}-at`) : deps.now();
	const plan = transient ? planTransientWait(state, now) : planEngineWait({ resetsAt: result.waitUntil, resetHint: result.resetHint, now, state, timeZone: deps.timeZone });
	if (!plan.wait) {
		if (transient) return { resume: false, result: { ...result, outcome: "engine_error", detail: `The coding CLI's AI provider kept failing and ${plan.why}. ${result.detail ?? ""}`.trim() } };
		return { resume: false, result: { ...result, detail: engineWaitExhausted(result.detail, plan.why) } };
	}

	await deps.announce(enginePauseMessage(plan, result.detail ?? "", deps.timeZone));
	// `update`, not `alert`: nothing is being asked of the owner, and a park that pings like a
	// question is how people learn to stop reading these.
	await deps.notify(transient ? "⏸ Coder is waiting for the AI provider to recover" : "⏸ Coder is waiting on the CLI's usage limit", `${deps.repo}: resuming automatically`, `coding-wait:${round}`, false);

	// Chunked rather than one long sleep: the park has to out-tick three separate clocks (the driver
	// claim at 15 min, the run sweeper at 3h, the idle-session reaper at 6h) and has to be
	// cancellable. One loop does all four.
	const ticks = Math.max(1, Math.ceil(plan.ms / ENGINE_WAIT_TICK_MS));
	for (let i = 0; i < ticks; i++) {
		await deps.sleep(`ewait-${round}-${i}`, Math.min(ENGINE_WAIT_TICK_MS, plan.ms - i * ENGINE_WAIT_TICK_MS));
		// THE production writer of `waiting_until` (#591). `plan.until` is already computed and was
		// already being rendered into the chat sentence; it just never reached the record. Passed on
		// every tick rather than once, because the ticks are what survive a replay — a park that
		// re-heartbeats after an eviction must restate its end, not blank it.
		if (!(await deps.tick({ until: plan.until }))) {
			return {
				resume: false,
				result: { ...result, outcome: "cancelled", detail: "Stopped by you while waiting for the coding CLI's usage limit to reset." },
			};
		}
	}

	if (transient) state.transientWaits = (state.transientWaits ?? 0) + 1;
	else {
		state.waits += 1;
		state.spentMs += plan.ms;
	}
	await deps.announce(engineResumeMessage(plan));
	return { resume: true, resumeNote: engineResumeNote(plan, deps.timeZone) };
}

/**
 * The engine is not signed in (#881). Park until the re-auth relay reports a login, then resume.
 *
 * Not a takeover: the takeover view drives the ENGINE session, and a headless engine that could not
 * sign in has exited — there is nothing in it to take over, which is why these runs sat out fifteen
 * minutes and died. What resolves it is the relay (`coding_engine_reauth`), which runs the engine's
 * subscription login on the runner and relays it to whatever device the owner is holding. Same
 * 15-minute bound as a handoff (the sweeper's park budget); the stop reason it ends on,
 * `engine_auth`, is resumable, so a login that lands after the park still continues the run.
 */
async function waitForSignIn(deps: PauseDeps, input: { round: number; result: CodingResult }): Promise<PauseVerdict> {
	const { result, round } = input;
	const since = deps.now();
	await deps.card("needs_human");
	// The sign-in prompt lives in the session view (#897), so with no board task the session is the sign-in screen.
	const notificationUrl = deps.taskId ? handoffLink(deps) : deepLinkFor({ kind: "engine-sign-in", instanceId: deps.instanceId, sessionId: deps.sessionId });
	const body = `${deps.repo}: the coding engine is not signed in. You have ${HANDOFF_GIVE_UP_MS / 60_000} minutes to sign in before the run gives up.`;
	await deps.notify("🔑 Coder needs you to sign in", body, `coding-reauth:${round}`, true, notificationUrl);
	await deps.announce(
		`🔑 **Coder needs you to sign in** — paused on ${deps.repo}: ${result.detail ?? "the coding engine is not signed in."} Sign it in from any device with coding_engine_reauth; the run continues by itself once it succeeds. If nobody signs it in within ${HANDOFF_GIVE_UP_MS / 60_000} minutes the run stops, and can be continued after signing in.`,
	);

	for (let poll = 0; poll < HANDOFF_WAIT_POLLS; poll++) {
		await deps.sleep(`reauth-${round}-${poll}`, HANDOFF_POLL_MS);
		const until = deps.now() + (HANDOFF_WAIT_POLLS - poll - 1) * HANDOFF_POLL_MS;
		if (poll % HANDOFF_TICK_EVERY === 0 && !(await deps.tick({ until }))) {
			return { resume: false, result: { ...result, outcome: "cancelled", detail: "Stopped by you while waiting for the coding engine to be signed in." } };
		}
		if (await deps.reauthCompletedSince(since).catch(() => false)) {
			const restarted = await deps.restartEngine().then(
				() => true,
				() => false,
			);
			await deps.card("running");
			await deps.announce(
				restarted
					? `🔑 **Signed in** — the coding engine on ${deps.repo} is signed in again and was restarted on the new sign-in; the run continues where it stopped.`
					: `🔑 **Signed in** — but the coding engine on ${deps.repo} could not be restarted, so it may still hold the old sign-in. If the run stops on sign-in again, restart the session (coding_session_restart) and continue it.`,
			);
			return {
				resume: true,
				ownerTurn: true,
				resumeNote: "The owner signed the coding engine in again (it had stopped on its own sign-in). Continue the objective from where it stopped; if the engine session ended, the next instruction starts it again.",
			};
		}
	}
	return {
		resume: false,
		result: {
			...result,
			detail: `Waiting on sign-in: ${result.detail ?? "the coding engine is not signed in."} Nobody signed it in within ${HANDOFF_GIVE_UP_MS / 60_000} minutes, so the run stopped here — sign in with coding_engine_reauth, then continue the run.`,
		},
	};
}

// ── How an outcome is reported ──────────────────────────────────────────────

/**
 * The loop-run reason for a Pilot outcome.
 *
 * A pure table rather than the ternary chain this replaces, because two of its rows are the point
 * of #541 and a chain is where they would have been added invisibly:
 *
 *   * `stuck` / `needs_input` → `escalated`, so an unanswered handoff reads "needs you" instead of
 *     "failed". `statusFor("escalated")` is `needs_human`.
 *   * `waiting` → `engine_limit`, distinct from BOTH, which is what makes "the CLI is still
 *     throttled" and "somebody has to click something" tellable apart in `coding_loop_status`'s
 *     `stopReason` — the two now end in different states for different reasons and must not be
 *     read as the same event.
 */
export function stopReasonFor(outcome: CodingOutcome): LoopStopReason {
	switch (outcome) {
		case "cancelled":
			return "cancelled";
		case "max_steps":
			return "max_iterations";
		case "failed":
			return "failed";
		case "stuck":
		case "needs_input":
			return "escalated";
		case "waiting":
			return "engine_limit";
		case "needs_reauth":
			return "engine_auth";
		case "engine_error":
			return "engine_error";
		case "done":
			return "done";
		default: {
			// Exhaustive (#1354): an outcome added to `CodingOutcome` without a row here is a compile error. It used to fall
			// to `done`, so an unmapped ending would have been reported as "Finished".
			const unmapped: never = outcome;
			return unmapped;
		}
	}
}

/**
 * Is this an outcome the end notification and the board card may report positively?
 *
 * Preserves the existing predicate for every outcome that could already reach it — including
 * `cancelled`, which has always closed a card as `completed` because a run somebody stopped did not
 * fail. What it ADDS is that `stuck`, `needs_input` and `waiting` are excluded: before #541 they
 * could not arrive here at all (an expired handoff was rewritten to `failed` first), so the old
 * `!== "failed" && !== "max_steps"` test would now greet a run that stopped waiting on the owner
 * with "✅ Coder finished".
 */
export function runSucceeded(outcome: CodingOutcome): boolean {
	return outcome === "done" || outcome === "cancelled";
}
