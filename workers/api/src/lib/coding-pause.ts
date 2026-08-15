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
	type EngineWaitState,
} from "./coding-wait.js";
import type { LoopStopReason } from "./agent-loop.js";
import type { CodingOutcome, CodingResult } from "./coding-loop.js";

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

export interface PauseDeps {
	/** Repo label, for the notification body. */
	repo: string;
	/** The owner's IANA zone, or undefined. Rendered as UTC, out loud, when unset. */
	timeZone?: string;
	/** Open the console takeover on the runner. */
	takeover: (label: string, reason: "stuck" | "needs_input") => Promise<void>;
	/** Has the human resolved it, and with what value? */
	takeoverStatus: () => Promise<{ resolved: boolean; value?: string }>;
	/** Close the takeover once it is resolved. */
	endTakeover: () => Promise<void>;
	/** A DURABLE sleep — `step.sleep`, so a six-hour park survives the workflow being evicted. */
	sleep: (label: string, ms: number) => Promise<void>;
	/**
	 * Push notification to the owner. `alert` outranks a "Coder" mute — set only for a handoff,
	 * which STOPS the engine until someone answers. A usage-limit park needs nothing from anyone
	 * and must not ping like a question, or people learn to stop reading these.
	 */
	notify: (title: string, body: string, key: string, alert: boolean) => Promise<void>;
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
}

export type PauseVerdict =
	| { resume: true; userHint?: string; resumeNote?: string; ownerTurn?: boolean }
	| { resume: false; result: CodingResult };

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
	if (result.outcome !== "stuck" && result.outcome !== "needs_input") return { resume: false, result };
	return waitForHuman(deps, input);
}

async function waitForHuman(deps: PauseDeps, input: { round: number; result: CodingResult }): Promise<PauseVerdict> {
	const { result, round } = input;
	const reason = result.outcome === "needs_input" ? "needs_input" : "stuck";
	const label = reason === "needs_input" ? (result.fieldNeeded ?? "a value") : (result.detail ?? "this step");

	await deps.takeover(label, reason);
	// The board FIRST, before the two pushes. It is the surface that persists, so if anything after
	// this throws, the durable record still says the run is waiting on somebody — rather than the
	// state that produced #553, where the notification fired and the board said everything was fine.
	await deps.card("needs_human");
	// The Engine is stopped until someone answers — `alert`, so muting "Coder" silences the
	// finished/stopped updates and never this.
	await deps.notify("🙋 Coder needs you", `${deps.repo}: ${label}`, `coding-handoff:${reason}:${round}`, true);
	// …AND in the thread the run was started from (#541 item d). A runner disconnect has always been
	// announced in chat; a handoff never was, so the conversation the owner started the run from said
	// nothing at all while the run waited on him, and then reported that it had failed.
	// The deadline is said OUT LOUD (#596 AC2). It was computable from the first line of this
	// function and was never published anywhere, so the one wait an owner can still beat was the one
	// that never stated its clock — while the usage-limit park, which needs nothing from anybody,
	// announced its resume time in this same thread. "Take over" without "by when" is why three runs
	// sat here for the full fifteen minutes and then reported that they had been waiting on someone.
	await deps.announce(
		`🙋 **Coder needs you** — paused on ${deps.repo}: ${label}. Open the session and take over; the run resumes where it stopped. If nobody does within ${HANDOFF_GIVE_UP_MS / 60_000} minutes it stops and reports that it is waiting on you.`,
	);

	let resolved = false;
	let value: string | undefined;
	for (let poll = 0; poll < HANDOFF_WAIT_POLLS && !resolved; poll++) {
		await deps.sleep(`wait-${round}-${poll}`, HANDOFF_POLL_MS);
		// The park's end, published (#596). It used to be withheld: `waiting_until` was rendered
		// unconditionally as "expected to resume in …", so a give-up time under it would have told an
		// owner to sit and wait for a run that was about to stop waiting for THEM. The renderer now
		// reads the KIND of deadline off the park reason (`work-report.ts`'s `PARKS`), so the honest
		// move flips: withholding it hides the only deadline the reader can still act on.
		//
		// Computed from the polls REMAINING rather than from a deadline captured before the loop, so
		// it names the same absolute instant on every tick and stays right after a Workflow replay —
		// where the loop restarts and a captured deadline would have slid forward by a whole wait.
		const until = deps.now() + (HANDOFF_WAIT_POLLS - poll - 1) * HANDOFF_POLL_MS;
		if (poll % HANDOFF_TICK_EVERY === 0 && !(await deps.tick({ until }))) {
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
				detail: `Waiting on you: ${label}. Nobody took the session over within ${HANDOFF_GIVE_UP_MS / 60_000} minutes, so the run stopped here.`,
			},
		};
	}

	await deps.endTakeover();
	// Somebody answered — the run is working again, so it leaves "Needs you". Not left for the
	// terminal write: a run can take several handoffs across its 12 rounds, and a card that stayed
	// in "Needs you" through the working stretches would ask for attention it does not need, which
	// is how a column stops being read.
	await deps.card("running");
	return {
		resume: true,
		ownerTurn: true,
		userHint: reason === "needs_input" && value && result.fieldNeeded ? `${result.fieldNeeded}: ${value}` : undefined,
	};
}

async function waitForEngineReset(
	deps: PauseDeps,
	input: { round: number; result: CodingResult; state: EngineWaitState },
): Promise<PauseVerdict> {
	const { result, round, state } = input;
	const plan = planEngineWait({ resetsAt: result.waitUntil, now: deps.now(), state, timeZone: deps.timeZone });
	if (!plan.wait) {
		return { resume: false, result: { ...result, detail: engineWaitExhausted(result.detail, plan.why) } };
	}

	await deps.announce(enginePauseMessage(plan, result.detail ?? "", deps.timeZone));
	// `update`, not `alert`: nothing is being asked of the owner, and a park that pings like a
	// question is how people learn to stop reading these.
	await deps.notify("⏸ Coder is waiting on the CLI's usage limit", `${deps.repo}: resuming automatically`, `coding-wait:${round}`, false);

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

	state.waits += 1;
	state.spentMs += plan.ms;
	await deps.announce(engineResumeMessage(plan));
	return { resume: true, resumeNote: engineResumeNote(plan, deps.timeZone) };
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
 *     throttled" and "somebody has to click something" tellable apart in `check_instance_loop`'s
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
		default:
			return "done";
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
