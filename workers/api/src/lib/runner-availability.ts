// Is the runner GONE, or just gone for a moment? (#341)
//
// ── The incident
//
// Heartfull Coder, objective "work through all 30 open issues", `maxIterations: 50`. Two steps
// reached the engine. At 279 seconds — iteration 2 of 50 — the run ended with "run error: No
// runner connected — run `pags up`", while `pags up` was running.
//
// Two separate mistakes, and raising a timeout fixes neither:
//
//   1. The wait was shorter than the recovery it was waiting for. A `step.do` retry budget of
//      2 × 2s gave the runner ~4 seconds to be absent. The runner's own relay client reconnects
//      with exponential backoff capped at 30 SECONDS, so the workflow gave up while the runner
//      was still inside the retry loop it is designed to win. Any budget under ~30s loses that
//      race by construction; a bigger number just moves the cliff.
//
//   2. Losing the runner ENDED the run. A run with 48 iterations left has time to wait — the
//      delivery outbox (#239) already waits 1m·5m·15m·1h·3h for exactly this class of event,
//      with the reasoning written down: these retries wait out someone else's outage. So the
//      fix is not a longer timeout but a different terminal condition: a disconnect is a PAUSE,
//      and only a runner that never comes back is a failure.
//
// ── Why a field and not a string
//
// Following 99bf6d8 (#339/#321): a connectivity failure KNOWS whether it is transient, rather
// than having it inferred at the catch site from the wording of a message. `callRunner` raises
// {@link RunnerUnreachableError} when the relay itself reports there is no socket, or that the
// socket dropped mid-command — those are protocol facts from the RelayDO, not guesses.
//
// The class alone is not enough to survive a Cloudflare Workflow step boundary (the engine
// serialises a thrown error and the receiving side gets its message, not its prototype), so
// {@link isRunnerUnreachable} also matches the stable marker the message carries. And the
// guard's LAST resort is not the error at all: it asks the relay whether a socket is live right
// now. A fact beats both the class and the string.
//
// ── Why the message changed
//
// `diagnoseAttachment` (#237) already distinguishes never-registered / runner-offline /
// machine-online-agent-detached, each with the remedy that actually applies — and
// `pags up --force` is the right answer for one of them, which a hardcoded "run `pags up`" can
// never say. Telling someone to run a command they are already running is the #259/#271/#321
// failure: a confident wrong message sends them chasing the wrong fix.
//
// The error class itself is one level down in `runner-unreachable.ts`, a leaf: `runner-client.ts`
// must be able to raise it, and the connectivity read below imports `runner-client.ts`. And
// `RuntimeFacts` is a TYPE-only import with `noRunnerDetail` taking facts rather than an Env, for
// the same reason — `import-graph.test.ts` forbids a static cycle even when it is erased.
import { diagnoseAttachment, type AttachmentDiagnosis, type AttachmentState } from "./runtime-attachment.js";
import { isRunnerGone, isRunnerUnreachable, isRunnerUnresponsive, RunnerGoneError } from "./runner-unreachable.js";
import type { RuntimeFacts } from "./instance-connectivity.js";

// Re-exported so a caller needs ONE import for "was it the runner, and what do I do about it".
export * from "./runner-unreachable.js";

// ── The wait ────────────────────────────────────────────────────────────────

/**
 * How often to ask the relay whether the runner is back.
 *
 * Half the runner's own 30s backoff cap, so a reconnect is noticed within one interval of
 * happening rather than being averaged over it.
 */
export const RUNNER_PROBE_INTERVAL_MS = 15_000;
export const RUNNER_PROBE_INTERVAL = "15 seconds";

/**
 * How long ONE disconnect may pause a run.
 *
 * Sized against the thing being waited for, not picked round: the runner reconnects with
 * exponential backoff capped at 30s, so this is ~20 reconnect attempts. It covers a wifi
 * handover, a `pags up` restart and a quick CLI upgrade. A closed laptop lid, a night away or a
 * slow update outlasts it, and the run then PARKS ({@link RUNNER_PARK_MS}, #1160) instead of
 * ending. It is deliberately UNDER `STALE_DRIVER_MS` (15 min), so a single pause
 * cannot outlive the single-flight claim the run holds on its session even if the heartbeat
 * were to stop.
 */
export const RUNNER_WAIT_MS = 10 * 60_000;

/**
 * How long a whole run may spend waiting, across every disconnect.
 *
 * Without it, a machine that flaps every nine minutes holds a workflow open forever. Thirty
 * minutes is enough for three separate outages and short enough that a genuinely dead machine
 * is reported the same day.
 */
export const RUNNER_WAIT_TOTAL_MS = 30 * 60_000;

/**
 * How long a run may stay PARKED for a machine that went away, across the whole run (#1160).
 *
 * The ten-minute wait above is a POLL, sized for a blip. A laptop shut for lunch or overnight, or an
 * update that took the machine down, outlasts it, and the run used to end `runner_gone` with nothing to
 * continue it when the machine came back. Past the poll the run now PARKS: at zero compute on
 * `step.waitForEvent`, its `waiting_until` published, woken when the machine re-registers. A day
 * covers a night away and the morning after; a machine gone longer than that is reported as gone,
 * with this bound named in the message.
 */
export const RUNNER_PARK_MS = 24 * 60 * 60_000;

/**
 * How often a parked run looks again on its own, without the re-registration event. Also its
 * heartbeat, so it stays UNDER `STALE_DRIVER_MS` (15 min): a parked run keeps its claim on its session.
 */
export const RUNNER_PARK_CHECK_MS = 10 * 60_000;

/** After a wake, how long to poll for the socket: a runner registers before its relay connects. */
export const RUNNER_WAKE_POLL_MS = 2 * 60_000;

/** The event a run parked on its machine waits for. Cloudflare allows `[A-Za-z0-9_-]`, at most 100 characters: a run id is a uuid, so it fits whole. */
export function runnerBackEventType(runId: string): string {
	return `runner-back-${runId}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * What the guard needs to PARK a run on its machine (#1160). The workflow supplies durable versions;
 * a run without a loop-run row cannot be woken, so it supplies none and keeps the old ending.
 */
export interface RunnerParkDeps {
	/** The wall clock, journalled (a `step.do`), so a replay agrees with itself about how long it waited. */
	now: (label: string) => Promise<number>;
	/** Record the park — `runner_away`, until `until` — so the owner can see it and the registration route can wake it. */
	begin: (label: string, until: number) => Promise<void>;
	/** Wait at zero compute for the machine's re-registration, or `timeoutMs`. True when the event arrived. */
	waitForBack: (label: string, timeoutMs: number) => Promise<boolean>;
	/** Clear the park. */
	end: (label: string) => Promise<void>;
}

/** Re-attempts of one step around a disconnect before the loss is treated as terminal. */
export const RECONNECT_ROUNDS = 3;

/**
 * The wait as RUN STATE (#1177): while the guard waits for a machine the run row says `runner_away` with the instant the wait gives up,
 * so health reads "waiting for its machine" instead of `working` and then `stalled`. Supplied by the workflow; absent, the wait records nothing.
 */
export interface RunnerWaitState {
	/** The wall clock, journalled, so a replay agrees with itself about when the wait began. */
	now: (label: string) => Promise<number>;
	/** The run is waiting for its machine until `until` (the instant it gives up), journalled. */
	begin: (label: string, until: number) => Promise<void>;
	/** The machine is back, or the wait is over: clear the reason, journalled. */
	end: (label: string) => Promise<void>;
}

export interface RunnerWaitDeps {
	/**
	 * Live connectivity, resolved the way delegation resolves it (`runtimeConnectivity`). Given a `label`, the answer is JOURNALLED
	 * (#1177): a workflow replays its body, and a live read there answers differently the second time (the runner is back), which sent the
	 * replay down a different path than the original — a budget undercounted, a notice posted again. Without a label it is a live read.
	 */
	probe: (label?: string) => Promise<RuntimeFacts>;
	/** A DURABLE sleep — `step.sleep`, so the pause survives an eviction. */
	sleep: (label: string) => Promise<void>;
	/**
	 * One line into the owner's thread. A pause nobody can see is indistinguishable from a hang (#252). Given a `label`, it is posted
	 * ONCE per label however many times the workflow replays past it (#1177).
	 */
	announce: (message: string, label?: string) => Promise<void>;
	/** Called on each tick while paused — the run still owns its session and should say so, and its liveness stays current without claiming progress. */
	tick?: (waitedMs: number, label?: string) => Promise<void>;
	/** The wait as run state (#1177). */
	state?: RunnerWaitState;
}

export interface RunnerWaitResult {
	returned: boolean;
	/** Counted in ticks, not wall clock: a Workflow replays, and `Date.now()` would not agree with itself. */
	waitedMs: number;
	state: AttachmentState;
	message: string;
	remedy: string | null;
}

/**
 * Facts in, sentence out — and ALL the facts (#461).
 *
 * This adapter used to forward three of the five inputs `diagnoseAttachment` takes, dropping the
 * pin. It is the only path three surfaces reach the diagnosis by (this file's two pause messages
 * and `noRunnerDetail`, plus the repos list's `recheck.reason`), so `pinned-machine-offline` was
 * correct, tested, and dead everywhere it was needed: every one of them fell through to
 * `machine-online-agent-detached` and prescribed `pags up --force` at a machine that is switched
 * off, while `pags up` was already running on another one with a live socket for that instance.
 *
 * Forward everything, and let the diagnosis decide. A field added to `RuntimeFacts` for the
 * diagnosis's benefit and not passed here is the same bug again.
 */
export function describeFacts(facts: RuntimeFacts): AttachmentDiagnosis {
	return diagnoseAttachment({
		hasRuntimeRow: facts.hasRuntimeRow,
		relayConnected: facts.relayConnected,
		lastSeenAt: facts.lastSeenAt,
		pinnedNode: facts.pinnedNode,
		liveNodeExcludedByPin: facts.liveNodeExcludedByPin,
	});
}

export function formatDuration(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms >= 2 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))} hours`;
	const m = Math.round(ms / 60_000);
	return `${m} minute${m === 1 ? "" : "s"}`;
}

export function pauseMessage(d: AttachmentDiagnosis, waitMs: number): string {
	return [
		"⏸ **Runner unreachable — pausing, not stopping.**",
		d.message,
		`Waiting up to ${formatDuration(waitMs)} for it to come back; the run resumes at the same step.`,
		"The runner reconnects on its own (backing off up to 30s), so this usually needs nothing from you.",
	].join(" ");
}

/**
 * The pause for a runner that is connected but not answering (#913). `describeFacts` would call it
 * attached — its socket IS up — so this one says what was actually observed.
 */
export function slowRunnerMessage(waitMs: number): string {
	return [
		"⏸ **Runner not answering — pausing, not stopping.**",
		"Its relay is connected but did not reply in time — usually a machine under heavy load, asleep, or a connection that stalled.",
		`Waiting up to ${formatDuration(waitMs)} for it to answer again; the run resumes at the same step.`,
	].join(" ");
}

export function resumeMessage(node: string | null, waitedMs: number): string {
	return `▶️ **Runner is back**${node ? ` on ${node}` : ""} after ${formatDuration(waitedMs)} — resuming where it stopped.`;
}

/**
 * The message this ticket is really about. It names what was observed and the remedy that fits
 * THAT observation — including `pags up --force`, which the old hardcoded string could not say.
 */
export function runnerGoneMessage(d: AttachmentDiagnosis, waitedMs: number): string {
	const waited = waitedMs > 0 ? ` after waiting ${formatDuration(waitedMs)}` : "";
	return `The runner did not come back${waited}. ${d.message}${d.remedy ? ` Try: \`${d.remedy}\`` : ""}`;
}

/** An instant as an owner reads it in the thread: UTC, to the minute. */
function utcMinute(ms: number): string {
	return `${new Date(ms).toISOString().replace("T", " ").replace(/:\d\d\.\d+Z$/, "")} UTC`;
}

export function parkMessage(d: AttachmentDiagnosis, until: number, leftMs: number): string {
	return [
		"⏸ **Runner away — the run is parked, not stopped.**",
		d.message,
		`It waits until ${utcMinute(until)} (${formatDuration(leftMs)}) and continues by itself, at the same step, as soon as the machine reconnects${d.remedy ? ` (\`${d.remedy}\`)` : ""}.`,
		"Past that it stops as runner_gone.",
	].join(" ");
}

export function parkExpiredMessage(d: AttachmentDiagnosis, parkedMs: number): string {
	return `The runner did not come back: this run waited ${formatDuration(parkedMs)} for its machine, the longest a run waits (${formatDuration(RUNNER_PARK_MS)}). ${d.message}${d.remedy ? ` Try: \`${d.remedy}\`` : ""}`;
}

/**
 * Pause until the runner returns, or until the budget runs out.
 *
 * Pure over {@link RunnerWaitDeps} — no D1, no relay, no Workflow — so the whole pause/resume
 * machine unit-tests without any of them, the same way `runCodingLoop` does.
 */
export async function waitForRunner(deps: RunnerWaitDeps, opts: { label: string; waitMs: number; unresponsive?: boolean; extraMs?: number }): Promise<RunnerWaitResult> {
	let facts = await deps.probe(`${opts.label}-q`);
	// After a runner that did not ANSWER, the instant read is the one fact not to trust (#913): it
	// counts the failed dispatch's own milliseconds-old ping as connected, so the wait returned after
	// 0ms and the run re-dispatched straight into the same silence. Waiting one interval first is
	// what lets a loaded machine catch up — and a frozen one read as disconnected by then.
	if (facts.relayConnected && !opts.unresponsive) {
		// Already healed between the failure and this probe — the common case for a blip shorter
		// than the step's own retries. Nothing to announce; the run just carries on.
		return { returned: true, waitedMs: 0, state: "attached", message: "", remedy: null };
	}

	const ticks = Math.max(0, Math.floor(opts.waitMs / RUNNER_PROBE_INTERVAL_MS));
	if (ticks > 0) {
		// The wait is run state before it is a notice (#1177): `runner_away` until the instant it gives up — the end of this poll, plus the
		// park that follows it when the run can park — so a reader of the run row sees a wait, not work and then a stall.
		if (deps.state) {
			const start = await deps.state.now(`${opts.label}-t0`);
			await deps.state.begin(`${opts.label}-w0`, start + opts.waitMs + (opts.extraMs ?? 0));
		}
		await deps.announce(opts.unresponsive && facts.relayConnected ? slowRunnerMessage(opts.waitMs) : pauseMessage(describeFacts(facts), opts.waitMs), `${opts.label}-n`);
	}

	for (let i = 0; i < ticks; i++) {
		await deps.sleep(`${opts.label}-p${i}`);
		const waited = (i + 1) * RUNNER_PROBE_INTERVAL_MS;
		await deps.tick?.(waited, `${opts.label}-k${i}`);
		facts = await deps.probe(`${opts.label}-q${i}`);
		if (facts.relayConnected) {
			await deps.state?.end(`${opts.label}-w1`);
			await deps.announce(resumeMessage(facts.node, waited), `${opts.label}-back`);
			return { returned: true, waitedMs: waited, state: "attached", message: "", remedy: null };
		}
	}

	const waited = ticks * RUNNER_PROBE_INTERVAL_MS;
	// Connected-but-silent with no budget left to wait: describing the socket would say "attached".
	if (opts.unresponsive && facts.relayConnected) {
		return { returned: false, waitedMs: waited, state: "attached", message: "The runner stayed connected but did not answer — usually a machine under heavy load. Free it up (fewer concurrent sessions), or move this agent to another machine.", remedy: null };
	}
	const d = describeFacts(facts);
	return { returned: false, waitedMs: waited, state: d.state, message: runnerGoneMessage(d, waited), remedy: d.remedy };
}

// ── The guard ───────────────────────────────────────────────────────────────

/**
 * Run one durable step. The caller supplies the retry/timeout options it wants by binding them.
 *
 * Deliberately non-generic: Cloudflare's `step.do` constrains its result to `Rpc.Serializable`,
 * which a generic wrapper cannot carry through, so the type is erased here and restored by the
 * guard's own type parameter.
 */
export type RunStep = (name: string, fn: () => Promise<unknown>) => Promise<unknown>;

export type RunnerGuard = <T>(run: RunStep, name: string, fn: () => Promise<T>) => Promise<T>;

/**
 * Wrap a durable step so a runner disconnect pauses it instead of ending the run.
 *
 * The budget is held HERE, across every guarded step, because "how long may this run wait" is a
 * property of the run and not of whichever capture happened to be in flight when the wifi
 * dropped.
 */
export function makeRunnerGuard(cfg: {
	wait: RunnerWaitDeps;
	/** Re-point at whatever machine is live now, and make sure the session exists on it. */
	reconnect: (label: string) => Promise<void>;
	/**
	 * Did this error mean the runner is up but no longer holds a session the run still owns (#1053)? A runner
	 * that restarted between two calls answers `No coding session` over a live relay, which the probe below
	 * would otherwise read as a genuine failure. Absent: no such check, the pre-#1053 behaviour.
	 */
	sessionLost?: (e: unknown) => Promise<boolean>;
	/** Park past the poll instead of ending (#1160). Absent: a poll that runs out ends the run, as before. */
	park?: RunnerParkDeps;
	waitMsPerLoss?: number;
	totalWaitMs?: number;
	parkTotalMs?: number;
}): RunnerGuard {
	const perLoss = cfg.waitMsPerLoss ?? RUNNER_WAIT_MS;
	const total = cfg.totalWaitMs ?? RUNNER_WAIT_TOTAL_MS;
	const parkTotal = cfg.parkTotalMs ?? RUNNER_PARK_MS;
	let spent = 0;
	let parked = 0;

	return async function guard<T>(run: RunStep, name: string, fn: () => Promise<T>): Promise<T> {
		for (let round = 0; ; round++) {
			try {
				// A Workflow step name must be unique within an instance, so a re-attempt gets its own.
				return (await run(round === 0 ? name : `${name}-r${round}`, fn)) as T;
			} catch (e) {
				if (isRunnerGone(e) || round >= RECONNECT_ROUNDS) throw e;
				// The machine is back but the engine is not: relaunch it, as a heal would, and re-run the step (#1053).
				if (cfg.sessionLost && (await cfg.sessionLost(e).catch(() => false))) {
					await cfg.reconnect(`${name}-lost${round}`);
					continue;
				}
				// A genuine failure must still fail IMMEDIATELY — that is the acceptance criterion this
				// change is most likely to break. So when the error does not say it is a disconnect, ask
				// the relay: a live socket means the runner is fine and this error is about something
				// else. One cheap DO fetch buys the difference between waiting and mis-waiting.
				if (!isRunnerUnreachable(e) && (await cfg.wait.probe(`${name}-chk${round}`).catch(() => null))?.relayConnected) throw e;
				await recover(name, round, isRunnerUnresponsive(e));
			}
		}
	};

	/**
	 * Wait for the runner, then reconnect — and a reconnect that meets the same disconnect is one more
	 * wait inside the SAME budget, not an error out of the guard (#913). The reconnect is a dispatch
	 * like any other, so on a slow machine it hit the bar the step had just failed, and its error
	 * escaped: the run died seconds into a ten-minute allowance. The budget still bounds it — every
	 * wait after an unanswered call spends at least one interval — and so does RECONNECT_ROUNDS.
	 */
	async function recover(name: string, round: number, unresponsive: boolean): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			const tag = attempt === 0 ? `${round}` : `${round}-${attempt}`;
			const budget = Math.min(perLoss, Math.max(0, total - spent));
			const w = await waitForRunner(cfg.wait, { label: `${name}-w${tag}`, waitMs: budget, unresponsive, extraMs: cfg.park ? Math.max(0, parkTotal - parked) : 0 });
			spent += w.waitedMs;
			// A machine that went AWAY parks the run (#1160). One still connected but silent does not: it is
			// registered, so no re-registration would ever wake the park, and the honest answer is the one below.
			if (!w.returned && cfg.park && w.state !== "attached") {
				await parkUntilBack(cfg.park, `${name}-w${tag}`);
			} else if (!w.returned) {
				throw new RunnerGoneError(
					budget <= 0
						? `${w.message} This run has already spent its ${formatDuration(total)} of waiting for the runner.`
						: w.message,
				);
			}
			try {
				await cfg.reconnect(`${name}-rc${tag}`);
				return;
			} catch (re) {
				if (isRunnerGone(re) || !isRunnerUnreachable(re) || attempt >= RECONNECT_ROUNDS) throw re;
				unresponsive = isRunnerUnresponsive(re);
			}
		}
	}

	/**
	 * Park the run until its machine is back, or until the run's park budget is spent (#1160).
	 *
	 * Woken by the machine's re-registration (`wakeRunnerParkedRuns`), and on its own every
	 * {@link RUNNER_PARK_CHECK_MS} — so a lost event costs minutes, not the run. A wake only LOOKS: the
	 * relay is asked, and a runner that registered but whose socket is not up yet gets a short poll.
	 * Returns when the runner is connected; throws {@link RunnerGoneError} with the bound named otherwise.
	 */
	async function parkUntilBack(p: RunnerParkDeps, label: string): Promise<void> {
		const start = await p.now(`${label}-pk`);
		const left = parkTotal - parked;
		let facts = await cfg.wait.probe(`${label}-pk-q`);
		if (left <= 0) throw new RunnerGoneError(parkExpiredMessage(describeFacts(facts), parked));
		const until = start + left;
		await p.begin(`${label}-pk-begin`, until);
		await cfg.wait.announce(parkMessage(describeFacts(facts), until, left), `${label}-pk-n`);
		// The wake poll below neither announces nor touches the wait state: the park owns both until it ends.
		const quiet: RunnerWaitDeps = { ...cfg.wait, announce: async () => undefined, state: undefined };
		for (let i = 0; ; i++) {
			const at = await p.now(`${label}-pk${i}-at`);
			if (at >= until) {
				parked = parkTotal;
				await p.end(`${label}-pk-end`);
				throw new RunnerGoneError(parkExpiredMessage(describeFacts(facts), parked));
			}
			const woken = await p.waitForBack(`${label}-pk${i}`, Math.min(RUNNER_PARK_CHECK_MS, until - at));
			const now = await p.now(`${label}-pk${i}-t`);
			await cfg.wait.tick?.(now - start, `${label}-pk${i}-k`);
			const back = woken ? await waitForRunner(quiet, { label: `${label}-pk${i}-w`, waitMs: RUNNER_WAKE_POLL_MS }) : null;
			facts = await cfg.wait.probe(`${label}-pk${i}-q`);
			if (back?.returned || facts.relayConnected) {
				parked += now - start;
				await p.end(`${label}-pk-end`);
				await cfg.wait.announce(resumeMessage(facts.node, now - start), `${label}-pk-back`);
				return;
			}
		}
	}
}
/**
 * The runner answered that it holds no coding session with the id asked about — it restarted and lost
 * it (#1053). A runner from #1116 on answers 404 (a lookup, not a crash); an older one answered 500
 * with the same sentence, and installed runners of both kinds are in the field.
 */
export function isRunnerSessionAbsent(e: unknown): boolean {
	const msg = e instanceof Error ? e.message : "";
	return /^Runner \/coding\/\S+ → (404|500): .*"error":"No coding session: /.test(msg);
}

/**
 * Why is there no runner at all, at the moment a run starts?
 *
 * Same vocabulary as the pause above, so the two paths cannot disagree about what "offline"
 * means or what fixes it — including the one case a hardcoded string can never get right, where
 * the machine is online and the remedy is `pags up --force`. Facts in, sentence out: a diagnosis
 * whose read failed (null) must not be worse than the bare line it replaces.
 */
export function noRunnerDetail(facts: RuntimeFacts | null): string {
	const d = describeFacts(facts ?? { hasRuntimeRow: false, relayConnected: false, node: null, runnerVersion: null, lastSeenAt: null });
	return `No coding runner connected. ${d.message}${d.remedy ? ` Try: \`${d.remedy}\`` : ""}`;
}
