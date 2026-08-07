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
import { isRunnerGone, isRunnerUnreachable, RunnerGoneError } from "./runner-unreachable.js";
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
 * exponential backoff capped at 30s, so this is ~20 reconnect attempts. It covers a closed
 * laptop lid, a wifi handover, a `pags up` restart and a CLI upgrade — the events that produced
 * this ticket — and it is deliberately UNDER `STALE_DRIVER_MS` (15 min), so a single pause
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

/** Re-attempts of one step around a disconnect before the loss is treated as terminal. */
export const RECONNECT_ROUNDS = 3;

export interface RunnerWaitDeps {
	/** Live connectivity, resolved the way delegation resolves it (`runtimeConnectivity`). */
	probe: () => Promise<RuntimeFacts>;
	/** A DURABLE sleep — `step.sleep`, so the pause survives an eviction. */
	sleep: (label: string) => Promise<void>;
	/** One line into the owner's thread. A pause nobody can see is indistinguishable from a hang (#252). */
	announce: (message: string) => Promise<void>;
	/** Called on each tick while paused — the run still owns its session and should say so. */
	tick?: (waitedMs: number) => Promise<void>;
}

export interface RunnerWaitResult {
	returned: boolean;
	/** Counted in ticks, not wall clock: a Workflow replays, and `Date.now()` would not agree with itself. */
	waitedMs: number;
	state: AttachmentState;
	message: string;
	remedy: string | null;
}

export function describeFacts(facts: RuntimeFacts): AttachmentDiagnosis {
	return diagnoseAttachment({
		hasRuntimeRow: facts.hasRuntimeRow,
		relayConnected: facts.relayConnected,
		lastSeenAt: facts.lastSeenAt,
	});
}

export function formatDuration(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
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

/**
 * Pause until the runner returns, or until the budget runs out.
 *
 * Pure over {@link RunnerWaitDeps} — no D1, no relay, no Workflow — so the whole pause/resume
 * machine unit-tests without any of them, the same way `runCodingLoop` does.
 */
export async function waitForRunner(deps: RunnerWaitDeps, opts: { label: string; waitMs: number }): Promise<RunnerWaitResult> {
	let facts = await deps.probe();
	if (facts.relayConnected) {
		// Already healed between the failure and this probe — the common case for a blip shorter
		// than the step's own retries. Nothing to announce; the run just carries on.
		return { returned: true, waitedMs: 0, state: "attached", message: "", remedy: null };
	}

	const ticks = Math.max(0, Math.floor(opts.waitMs / RUNNER_PROBE_INTERVAL_MS));
	if (ticks > 0) await deps.announce(pauseMessage(describeFacts(facts), opts.waitMs));

	for (let i = 0; i < ticks; i++) {
		await deps.sleep(`${opts.label}-p${i}`);
		const waited = (i + 1) * RUNNER_PROBE_INTERVAL_MS;
		await deps.tick?.(waited);
		facts = await deps.probe();
		if (facts.relayConnected) {
			await deps.announce(resumeMessage(facts.node, waited));
			return { returned: true, waitedMs: waited, state: "attached", message: "", remedy: null };
		}
	}

	const waited = ticks * RUNNER_PROBE_INTERVAL_MS;
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
	waitMsPerLoss?: number;
	totalWaitMs?: number;
}): RunnerGuard {
	const perLoss = cfg.waitMsPerLoss ?? RUNNER_WAIT_MS;
	const total = cfg.totalWaitMs ?? RUNNER_WAIT_TOTAL_MS;
	let spent = 0;

	return async function guard<T>(run: RunStep, name: string, fn: () => Promise<T>): Promise<T> {
		for (let round = 0; ; round++) {
			try {
				// A Workflow step name must be unique within an instance, so a re-attempt gets its own.
				return (await run(round === 0 ? name : `${name}-r${round}`, fn)) as T;
			} catch (e) {
				if (isRunnerGone(e) || round >= RECONNECT_ROUNDS) throw e;
				// A genuine failure must still fail IMMEDIATELY — that is the acceptance criterion this
				// change is most likely to break. So when the error does not say it is a disconnect, ask
				// the relay: a live socket means the runner is fine and this error is about something
				// else. One cheap DO fetch buys the difference between waiting and mis-waiting.
				if (!isRunnerUnreachable(e) && (await cfg.wait.probe().catch(() => null))?.relayConnected) throw e;

				const budget = Math.min(perLoss, Math.max(0, total - spent));
				const w = await waitForRunner(cfg.wait, { label: `${name}-w${round}`, waitMs: budget });
				spent += w.waitedMs;
				if (!w.returned) {
					throw new RunnerGoneError(
						budget <= 0
							? `${w.message} This run has already spent its ${formatDuration(total)} of waiting for the runner.`
							: w.message,
					);
				}
				await cfg.reconnect(`${name}-rc${round}`);
			}
		}
	};
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
