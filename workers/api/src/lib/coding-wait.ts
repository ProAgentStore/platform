// The Engine's own usage limit is a CLOCK, not a person (#541).
//
// ── The incident
//
// Across the owner's 32 instances, `stuck not resolved in time` is the largest live class of dead
// Pilot runs (4 of the 11 failures in the post-`d951b5f` era). Three of the four are one thing, and
// the platform wrote the evidence itself — these are its own handoff notifications, verbatim:
//
//   "The Claude CLI session has hit its usage limit and resets at 10:30pm Australia/Sydney time."
//   "The Claude CLI session has hit its usage limit and will reset at 10:30pm Australia/Melbourne."
//
// Run 6550f673: handoff opened 16 SECONDS into the run, run declared `failed` at +15m15s — 41
// minutes before the reset it had just been told about, having done no work at all. The other two
// are the same shape (handoff at +23s and +24s).
//
// ── Why it happened, and why neither half was wrong
//
// `toDecision` offered the brain send_message / finish / request_human / request_user_info. There
// was no way to say "wait". Faced with "the CLI is rate-limited until 22:30", `request_human` is
// the only honest move it had — and `stuck` is bound to HANDOFF_WAIT_POLLS, 15 minutes, which is
// the right bound for "a human must click something" and the wrong one for "a subscription window
// reopens in 56 minutes". Once both are `stuck` the two are indistinguishable. The composition
// killed the run; neither decision was wrong on its own.
//
// So the fix is a VERB, not a bigger number. Raising HANDOFF_WAIT_POLLS is what #341 argued against
// for the runner case — "a bigger number with the same terminal behaviour only moves the cliff" —
// and it would degrade the case 15 minutes is right for in order to fix the case it is wrong for.
//
// ── Why a deadline is treated as a HINT and never as an authority
//
// The reset instant reaches us through a language model reading a terminal, so it can be wrong in
// three ways, and each has its own answer here rather than one shared shrug:
//
//   1. NO ZONE. "10:30pm" is 10:30pm somewhere. `Date.parse` on a naked local timestamp resolves
//      against the RUNTIME's zone, which in a Worker is UTC — a ten-hour error, silently. So
//      {@link parseResetInstant} REFUSES anything without an explicit offset or Z, and the prompt
//      is given the current instant AND the owner's offset (see {@link clockLine}) so the model can
//      convert rather than guess. Supplying the fact beats hoping the model has it.
//   2. UNPARSEABLE / ABSENT. Then there is no deadline to trust, and the honest fallback is the
//      coarse bounded retry the failure's own shape allows: it is cheap to detect and the reset is
//      coarse. {@link ENGINE_WAIT_BACKOFF_MS}.
//   3. IN THE PAST. The model's own reading says the window already reopened, so the pane is stale
//      or the conversion slipped. A short wait and a retry costs one minute and settles it; a full
//      backoff would punish the case that is nearly right.
//
// In every branch the sleep is clamped into [MIN, MAX] and against the run's remaining budget, and
// the NUMBER OF WAITS is bounded independently of the parse. A wrong deadline therefore costs at
// most one extra cycle — never an unbounded park.
//
// ── What waiting costs, stated rather than assumed
//
// A parked run holds three things, and each has a deadline of its own that the wait must out-tick:
//
//   * the session's single-flight driver claim — `STALE_DRIVER_MS`, 15 minutes;
//   * the loop-run row the sweeper reads — `STALE_RUN_MS`, 3 hours of no `last_progress_at`;
//   * the coding session itself — `IDLE_SESSION_MS`, 6 hours with nothing touching it.
//
// {@link ENGINE_WAIT_TICK_MS} is 5 minutes, a third of the tightest of the three, and the wait is
// therefore a LOOP of ticked chunks rather than one long sleep — which also makes it cancellable,
// since the same tick is where the run reads its cancel flag. It also holds the repo: one active
// session per repo, so a 56-minute park blocks that repo for 56 minutes. That is accepted
// deliberately: the alternative is ending the run and rescheduling it, which needs a resumption
// scheduler that does not exist, and the run that ends is the run that loses its objective, its
// step log and the engine's warm context — which is the expensive half.
//
// PURE. No D1, no Env, no Workflow — the effects live in `coding-pause.ts` the way `runCodingLoop`'s
// live in the workflow, so every rule below is testable as a rule.

/** Shortest park. A reset "already past" still gets a beat rather than an immediate re-decide. */
export const MIN_ENGINE_WAIT_MS = 60_000;

/**
 * Longest ONE park may last, however far away the reported reset is.
 *
 * Sized against the thing being waited for: Claude's usage window rolls over five hours, so six is
 * one full window plus margin. A deadline further out than this is either a different product's
 * limit or a bad parse, and both are better served by waking up and looking than by sleeping on it.
 */
export const MAX_ENGINE_WAIT_MS = 6 * 60 * 60_000;

/** How long a whole run may spend parked on usage limits, across every one it hits. */
export const ENGINE_WAIT_TOTAL_MS = 6 * 60 * 60_000;

/**
 * How many times one run may park.
 *
 * Bounded SEPARATELY from the time budget, because the failure this guards is not a long wait but
 * a cycle: park, wake, read the same stale limit message, park again. The resume note (see
 * {@link engineResumeNote}) is what should stop that; this is what stops it when the note does not.
 */
export const MAX_ENGINE_WAITS = 3;

/**
 * Tick interval while parked — a third of `STALE_DRIVER_MS` (15 min), the tightest of the three
 * clocks a parked run has to out-tick. Also the cancel-check interval: a run nobody is watching can
 * afford up to five minutes between "Stop" and stopping, and 5-minute chunks cost 72 durable steps
 * across a full six-hour park rather than the 4,320 a 5-second poll would.
 */
export const ENGINE_WAIT_TICK_MS = 5 * 60_000;

/**
 * The park to take when no trustworthy reset instant was reported.
 *
 * Wide and rising, for the same reason the delivery outbox's ladder is (#239): these waits are
 * waiting out somebody else's window, which reopens in minutes-to-hours. Indexed by how many times
 * this run has already parked.
 */
export const ENGINE_WAIT_BACKOFF_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000];

/** How the sleep length was arrived at — carried so the owner's line can say which it was. */
export type EngineWaitSource = "deadline" | "stale-deadline" | "backoff";

export interface EngineWaitPlan {
	wait: true;
	/** How long to park, already clamped into [MIN, MAX] and against the remaining budget. */
	ms: number;
	/**
	 * The instant the park ends, in epoch ms — a RESUME, which is the only kind this module plans.
	 *
	 * Worth naming because the other park in `coding-pause.ts` also states an instant and it means
	 * the opposite (the run gives up on the human then). Both land in the same `waiting_until`
	 * column and are told apart by the park REASON, never by the number (#596).
	 */
	until: number;
	source: EngineWaitSource;
	/** Set when the requested deadline was longer than this run could honour. */
	capped: boolean;
}

export interface EngineWaitRefusal {
	wait: false;
	/** Why no more waiting — the sentence that reaches the owner. */
	why: string;
}

export interface EngineWaitState {
	/** Parks already taken by this run. */
	waits: number;
	/** Milliseconds already spent parked by this run. */
	spentMs: number;
}

/**
 * An absolute instant, or null.
 *
 * The offset requirement is the whole point (see the header, failure 1). `2026-08-12T22:30:00` is
 * a valid ISO string that `Date.parse` resolves against the runtime zone — UTC in a Worker — so
 * accepting it would turn "10:30pm Sydney" into a ten-hour error that looks like a working parse.
 * Refusing it costs a fall through to the backoff, which is bounded and honest.
 */
export function parseResetInstant(raw: unknown): number | null {
	if (typeof raw !== "string") return null;
	const s = raw.trim();
	if (!s) return null;
	// Z, ±HH:MM or ±HHMM at the end, and only after something that looks like a time.
	if (!/\d(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) return null;
	const ms = Date.parse(s);
	return Number.isFinite(ms) ? ms : null;
}

/**
 * Plan one park, or refuse to take another.
 *
 * `timeZone` is the OWNER's, used only to render a refusal's reset instant. Optional and
 * UTC-when-absent for this module's standing reason: `formatLocal` says which zone it printed, and
 * a silently-assumed zone is the ten-hour error the whole file exists to avoid.
 */
export function planEngineWait(input: { resetsAt?: unknown; now: number; state: EngineWaitState; timeZone?: string }): EngineWaitPlan | EngineWaitRefusal {
	const { now, state } = input;
	if (state.waits >= MAX_ENGINE_WAITS) {
		return { wait: false, why: `the run has already waited ${state.waits} times for this limit to clear` };
	}
	const remaining = ENGINE_WAIT_TOTAL_MS - state.spentMs;
	if (remaining < MIN_ENGINE_WAIT_MS) {
		return { wait: false, why: `the run has used its ${formatDuration(ENGINE_WAIT_TOTAL_MS)} of waiting` };
	}

	const at = parseResetInstant(input.resetsAt);
	// A DEADLINE THIS RUN CANNOT REACH IS A REFUSAL, NOT A PARK (#580).
	//
	// The clamp below is what produced the incident. Run 70ea298e's engine reported "You've hit your
	// weekly limit · resets Aug 17 at 4pm" — a reset TWO DAYS out — and the plan clamped it to the
	// 6h ceiling and parked. Six hours later it would have woken, read the same limit, and been
	// refused anyway, because `ENGINE_WAIT_TOTAL_MS` is also 6h. So the terminal outcome was fixed
	// the moment the deadline was read; the only thing the park bought was 4.35 hours of a run
	// reporting `running` on iteration 1, holding the repo's one active session, while the owner
	// could not tell it from work.
	//
	// `capped` remains for the case it was written for — a deadline slightly beyond what is LEFT of
	// the budget, where waking early and looking again is genuinely better than giving up. This
	// refuses only when the reset is past what the run could reach even with its FULL budget, which
	// is a fact about the limit rather than about how much of the budget this run has spent.
	if (at !== null && at - now > Math.min(MAX_ENGINE_WAIT_MS, ENGINE_WAIT_TOTAL_MS)) {
		return {
			wait: false,
			why: `the limit does not reset until ${formatLocal(at, input.timeZone)}, which is beyond the ${formatDuration(ENGINE_WAIT_TOTAL_MS)} a run may wait — no amount of waiting inside this run can clear it`,
		};
	}
	let requested: number;
	let source: EngineWaitSource;
	if (at !== null && at > now) {
		requested = at - now;
		source = "deadline";
	} else if (at !== null) {
		// The model's own reading says the window already reopened — try again shortly rather than
		// serving a fifteen-minute backoff for a conversion that is probably nearly right.
		requested = MIN_ENGINE_WAIT_MS;
		source = "stale-deadline";
	} else {
		requested = ENGINE_WAIT_BACKOFF_MS[Math.min(state.waits, ENGINE_WAIT_BACKOFF_MS.length - 1)];
		source = "backoff";
	}

	const ceiling = Math.min(MAX_ENGINE_WAIT_MS, remaining);
	const ms = Math.max(MIN_ENGINE_WAIT_MS, Math.min(requested, ceiling));
	return { wait: true, ms, until: now + ms, source, capped: requested > ceiling };
}

// ── Words ───────────────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const minutes = Math.round(ms / 60_000);
	if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	const hours = Math.round(ms / 360_000) / 10;
	return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * `2026-08-12 21:34 +10:00` in the given zone, or a UTC ISO string when there is no zone.
 *
 * Assembled from `formatToParts` under `en-US` rather than formatted under a locale that happens to
 * print ISO order (`sv-SE`, `en-CA`): the field ORDER is then ours and cannot move with the ICU
 * data. `hourCycle: "h23"` rather than `hour12: false`, which renders midnight as "24" on some ICU
 * builds. Any failure — an invalid zone above all — falls back to UTC and SAYS it is UTC, because
 * `accountTimeZone` returns undefined on failure and a silently-assumed zone is the ten-hour error
 * this module exists to avoid.
 */
export function formatLocal(ms: number, timeZone?: string): string {
	const iso = new Date(ms).toISOString();
	if (!timeZone) return `${iso.slice(0, 16).replace("T", " ")} +00:00 (UTC)`;
	try {
		const parts: Record<string, string> = {};
		for (const p of new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
			timeZoneName: "longOffset",
		}).formatToParts(ms)) {
			parts[p.type] = p.value;
		}
		// `longOffset` is "GMT+10:00", and plain "GMT" at zero.
		const offset = (parts.timeZoneName ?? "GMT").replace(/^GMT$/, "GMT+00:00").replace(/^GMT/, "") || "+00:00";
		return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${offset} (${timeZone})`;
	} catch {
		return `${iso.slice(0, 16).replace("T", " ")} +00:00 (UTC)`;
	}
}

/**
 * The clock the Pilot is given on every decision.
 *
 * In the USER message, not the system prompt: the system prompt is static for a run, and a run that
 * parks for an hour and resumes would otherwise be reading a stale "now" to convert a reset time
 * with — which is the same class of error as having no clock at all. Both forms are stated so the
 * model can answer in whichever it finds easier and still be unambiguous.
 */
export function clockLine(now: number, timeZone?: string): string {
	return `Current time: ${new Date(now).toISOString()} — locally for the owner, ${formatLocal(now, timeZone)}.`;
}

/** The chat line when a park starts. A pause nobody can see is indistinguishable from a hang (#252). */
export function enginePauseMessage(plan: EngineWaitPlan, why: string, timeZone?: string): string {
	const how =
		plan.source === "deadline"
			? `until the reset it reported (${formatLocal(plan.until, timeZone)})`
			: plan.source === "stale-deadline"
				? "briefly — the reset time it reported has already passed, so this checks whether the limit really cleared"
				: "on a fixed backoff — no reset time was reported";
	return [
		"⏸ **The coding CLI has hit its own usage limit — pausing, not stopping.**",
		why,
		`Waiting ${formatDuration(plan.ms)} ${how}, then resuming at the same step.`,
		plan.capped ? "Capped at this run's remaining wait budget, so it may need to wait again." : "",
		"Nothing is needed from you — this is a clock, not a question.",
	]
		.filter(Boolean)
		.join(" ");
}

/** The chat line when the park ends. */
export function engineResumeMessage(plan: EngineWaitPlan): string {
	return `▶️ **Resuming** after waiting ${formatDuration(plan.ms)} for the coding CLI's usage limit.`;
}

/**
 * What the Pilot is told on the round after a park.
 *
 * This is the note that stops the park/wake/park cycle. `runCodingLoop` restarts its own step log
 * each round, so without it the resumed brain sees a terminal pane STILL SHOWING the limit message
 * it parked on — the CLI wrote that text once and nothing overwrites it — reads it as the current
 * state, and parks again. It is history, and the note says so and says what to do instead.
 */
export function engineResumeNote(plan: EngineWaitPlan, timeZone?: string): string {
	return [
		`PLATFORM NOTE (not from the human): this run was paused for ${formatDuration(plan.ms)} because the CLI reported its own usage limit. It is now ${formatLocal(plan.until, timeZone)}.`,
		"The limit message still visible in the terminal is HISTORY, not the current state — the CLI printed it once and nothing overwrites it.",
		"Send your next instruction and read what comes back. Only call wait_for_reset again if the CLI answers with a NEW limit message.",
	].join(" ");
}

/** The terminal detail when a run may not park again. */
export function engineWaitExhausted(why: string | undefined, refusal: string): string {
	return `The coding CLI is still reporting its own usage limit and ${refusal}. ${why ?? ""}`.trim();
}
