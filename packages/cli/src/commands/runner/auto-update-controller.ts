import { isVersion, olderThan } from "../../bootstrap/payload.js";
import { nextAutoUpdateDelayMs, type AutoUpdatePolicy, type AutoUpdateStatus } from "./auto-update.js";
import type { UpdateFacts, UpdateObservation, UpdatePlan } from "./self-update.js";

type UpdatePlanAction = Extract<UpdatePlan, { action: "update" }>;
type Timer = ReturnType<typeof setTimeout>;

export interface AutomaticUpdateControllerDeps {
	policy: () => { value: AutoUpdatePolicy; authoritative: boolean };
	/** Re-registers against the service; false means cached policy is not usable for mutation. Aborted when its bound expires. */
	refreshPolicy: (signal?: AbortSignal) => Promise<boolean>;
	/** The paired local-work look plus the registry read. Aborted when its bound expires. */
	facts: (signal?: AbortSignal) => Promise<UpdateFacts>;
	plan: (facts: UpdateFacts) => UpdatePlan;
	/** The relay's real npm + final-admission + restart bridge. */
	installAndRestart: (plan: UpdatePlanAction, automatic: boolean) => Promise<boolean>;
	status: (status: AutoUpdateStatus, extra?: Partial<AutoUpdatePolicy>) => void;
	setTimer?: (fn: () => void, ms: number) => Timer;
	clearTimer?: (timer: Timer) => void;
	random?: () => number;
	now?: () => number;
	/** The bound on one policy refresh or one facts look (#1020); its own timer, apart from the scheduling one. */
	boundTimer?: (fn: () => void, ms: number) => Timer;
}

/** Why an enabled controller is not installing yet — a normalized class, never raw session data (#1020). */
export type BlockerClass = "idle_wait" | "active_sessions" | "observation_failure" | "unknown";

/**
 * What the controller last DID, for the status report (#1020). The service stamps its own receipt
 * time separately, so a heartbeat re-sending these unchanged never reads as a new check or decision.
 */
export interface AutoUpdateDiagnostics {
	checkAt: number | null;
	decisionAt: number | null;
	nextRetryDueAt: number | null;
	blockerClass: BlockerClass | null;
	observations: UpdateObservation[];
}

const MAX_OBSERVATIONS = 5;
/** The deferred re-decision cadence while waiting for local work to finish. */
export const IDLE_RETRY_MS = 15_000;
/** How long one policy refresh, or one look at local work and the registry, may take before it counts as failed (#1020). */
export const OBSERVATION_TIMEOUT_MS = 30_000;

/**
 * Whether a check on the latest release VERIFIES an update cycle (#1020), or only finds the runner current.
 * `verified` needs this machine's own record of an attempted install (`running`/`restarting` with its target,
 * persisted before the restart), readable versions, a running version at or past that target, and a local
 * runtime that answered the paired work look. Anything less is never `verified-success`.
 */
export function updateVerdict(attempt: AutoUpdatePolicy, facts: UpdateFacts): { kind: "verified" | "current" } | { kind: "unverified"; reason: string } {
	const target = attempt.status === "running" || attempt.status === "restarting" ? attempt.latestVersion : undefined;
	if (!isVersion(facts.current) || !isVersion(facts.latest)) return { kind: "unverified", reason: `the running (${facts.current}) or published (${facts.latest}) version could not be read` };
	if (target === undefined) return { kind: "current" };
	if (!isVersion(target)) return { kind: "unverified", reason: `the attempted update's target (${target}) could not be read` };
	if (olderThan(facts.current, target)) return { kind: "unverified", reason: `the runner came back on ${facts.current}, not the attempted ${target}` };
	// Positive health evidence: BOTH halves of the paired look answered in the shape the guard reads. None, one, or a
	// malformed answer is not a healthy reattachment, and each says which.
	const observed = facts.observations ?? [];
	const answered = (source: string) => observed.some((o) => o.source === source && o.success);
	if (!observed.length) return { kind: "unverified", reason: `the runner is on ${facts.current}, but no health look was taken` };
	if (!answered("sessions") || !answered("health")) {
		return { kind: "unverified", reason: `the runner is on ${facts.current}, but its local runtime answered only partly (sessions ${answered("sessions") ? "ok" : "failed"}, health ${answered("health") ? "ok" : "failed"})` };
	}
	return { kind: "verified" };
}

/** The work names `observedRunnerWork` produces, reduced to one class. An empty wait is `unknown`, never idle. */
export function blockerClassFor(waitingFor: readonly string[]): BlockerClass {
	if (waitingFor.includes("runner-work-observation-unavailable")) return "observation_failure";
	return waitingFor.length ? "active_sessions" : "unknown";
}

/**
 * The unattended update state machine. It has no network or process globals of its own: the relay
 * injects registration, local-work observation, npm/restart and timers. That makes its sequencing
 * directly testable while keeping exactly one production implementation of it.
 */
export class AutomaticUpdateController {
	private timer: Timer | null = null;
	private checking = false;
	private waiting = false;
	private installing = false;
	private failures = 0;
	private checkAt: number | null = null;
	private decisionAt: number | null = null;
	private nextRetryDueAt: number | null = null;
	private blockerClass: BlockerClass | null = null;
	private observations: UpdateObservation[] = [];
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, ms: number) => Timer;
	private readonly clearTimer: (timer: Timer) => void;
	private readonly boundTimer: (fn: () => void, ms: number) => Timer;

	constructor(private readonly deps: AutomaticUpdateControllerDeps) {
		this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
		this.boundTimer = deps.boundTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.now = deps.now ?? Date.now;
	}

	/** The controller's own record, safe to report: times, a normalized class, and observation outcomes. */
	diagnostics(): AutoUpdateDiagnostics {
		return { checkAt: this.checkAt, decisionAt: this.decisionAt, nextRetryDueAt: this.nextRetryDueAt, blockerClass: this.blockerClass, observations: [...this.observations] };
	}

	/** Called only for a true policy transition. `keep` deliberately leaves a due heartbeat timer alone. */
	onPolicy(action: "start" | "cancel" | "keep") {
		if (action === "cancel") return this.cancel();
		if (action === "start") this.schedule(true);
	}

	/**
	 * Testable immediate entry point; production reaches it through the scheduled timer. Authority is
	 * NOT required to get here: a failed refresh clears it, and the retry is what re-establishes it.
	 */
	async runNow(): Promise<void> {
		if (this.checking || this.waiting || !this.retryable()) return;
		this.checking = true;
		try {
			if (!(await this.bounded((signal) => this.deps.refreshPolicy(signal))) || !this.enabled()) {
				this.offline();
				return;
			}
			await this.decide();
		} catch (error) {
			this.fail(error);
		} finally {
			this.checking = false;
		}
	}

	/** Explicit remote updates and unattended checks share this single flight. */
	async installManually(plan: UpdatePlanAction): Promise<boolean> {
		return this.install(plan, false);
	}

	/** May observe work, install or restart: only a freshly confirmed owner ON. */
	private enabled(): boolean {
		const { value, authoritative } = this.deps.policy();
		return authoritative && value.autoUpdate;
	}

	/**
	 * May keep a timer to re-read the policy: anything but an explicit OFF (#1020). The relay clears
	 * authority before every refresh, so a failed one left `enabled()` false and `schedule` refused —
	 * no timer, until a heartbeat happened to restore authority. The retry only refreshes; every
	 * install still passes `enabled()` and the relay's final admission.
	 */
	private retryable(): boolean {
		return this.deps.policy().value.autoUpdate;
	}

	private schedule(initial = false) {
		if (!this.retryable() || this.timer || this.waiting) return;
		const delay = initial ? Math.round(5_000 + (this.deps.random ?? Math.random)() * 25_000) : nextAutoUpdateDelayMs(this.failures, this.deps.random);
		this.timer = this.setTimer(() => { this.timer = null; this.nextRetryDueAt = null; void this.runNow(); }, delay);
		this.timer.unref?.();
		this.nextRetryDueAt = this.now() + delay;
	}

	private cancel() {
		if (this.timer) this.clearTimer(this.timer);
		this.timer = null;
		this.nextRetryDueAt = null;
	}

	/**
	 * The owner policy could not be re-read, so nothing installs (fail closed) — but the controller keeps
	 * a timer (#1020). It used to report `offline` and stop, leaving an enabled runner with no callback
	 * until the next policy transition. `schedule` itself refuses once the policy is disabled.
	 */
	private offline() {
		// A refresh that came back OFF is a disable, not an outage: nothing to report or retry.
		if (!this.retryable()) return;
		this.failures++;
		this.deps.status("offline", { reason: "The owner policy could not be refreshed; automatic update is deferred." });
		this.schedule();
	}

		private fail(error: unknown) {
		this.failures++;
		this.deps.status("failure", { reason: error instanceof Error ? error.message : String(error) });
		this.schedule();
	}

	/**
	 * One bounded piece of work (#1020): a policy refresh or a facts look. Past {@link OBSERVATION_TIMEOUT_MS} its
	 * signal is aborted (the relay drops that request's response, so a late answer can never restore authority) and
	 * this resolves null — the race has settled, so the late result cannot overwrite a newer one or reach planning,
	 * install or restart. A late rejection is absorbed rather than left unhandled.
	 */
	private async bounded<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
		const abort = new AbortController();
		let timer: Timer | undefined;
		const expired = new Promise<null>((resolve) => {
			timer = this.boundTimer(() => {
				abort.abort();
				resolve(null);
			}, OBSERVATION_TIMEOUT_MS);
			timer.unref?.();
		});
		const running = work(abort.signal);
		running.catch(() => undefined);
		try {
			return await Promise.race([running, expired]);
		} finally {
			if (timer) this.clearTimer(timer);
		}
	}

	private async decide(): Promise<void> {
		const facts = await this.bounded((signal) => this.deps.facts(signal));
		this.checkAt = this.now();
		if (!facts) {
			// A CHECK that failed, not a decision: `decisionAt` keeps the last real one.
			this.failures++;
			this.deps.status("failure", { reason: `The local work and registry check did not answer within ${OBSERVATION_TIMEOUT_MS / 1000}s; it will be retried.` });
			this.schedule();
			return;
		}
		if (facts.observations?.length) this.observations = [...this.observations, ...facts.observations].slice(-MAX_OBSERVATIONS);
		// Authority lost mid-check (a concurrent refresh failed): decide nothing, but keep the retry.
		if (!this.enabled()) return this.offline();
		const plan = this.deps.plan(facts);
		this.decisionAt = this.now();
		this.blockerClass = plan.action === "wait" ? blockerClassFor(plan.waitingFor) : null;
		if (plan.action === "up-to-date") {
			// Current is not the same claim as a verified update cycle (#1020): only an attempted install that came
			// back on its target with a healthy runtime is `verified-success`.
			const verdict = updateVerdict(this.deps.policy().value, facts);
			if (verdict.kind === "unverified") {
				this.failures++;
				this.deps.status("failure", { reason: `Not verified: ${verdict.reason}.` });
			} else {
				this.failures = 0;
				this.deps.status(verdict.kind === "verified" ? "verified-success" : "enabled", { latestVersion: facts.latest ?? undefined, reason: undefined });
			}
			this.schedule();
			return;
		}
		if (plan.action === "refused") {
			this.deps.status("unsupported", { reason: plan.reason });
			this.schedule();
			return;
		}
		if (plan.action === "wait") {
			this.deps.status("waiting-for-idle", { latestVersion: plan.latest, reason: undefined });
			this.defer();
			return;
		}
		this.deps.status("running", { latestVersion: plan.latest, reason: undefined });
		const restarted = await this.install(plan, true);
		if (restarted) {
			this.deps.status("restarting", { latestVersion: plan.latest, reason: undefined });
			return;
		}
		// The final, race-safe admission refused (work began during npm, the policy could not be
		// re-read, another install held the single flight). That refusal stays fail-closed — and it
		// must also be RETRIED, deferred or not (#1020). A deferred callback reaches here with its own
		// timer already spent, so returning without a new one left an enabled runner silent forever:
		// `waiting_for_idle` while idle, with nothing left to re-decide.
		this.blockerClass = "idle_wait";
		this.defer(plan.latest);
	}

	private defer(latest?: string) {
		if (this.waiting) return;
		this.waiting = true;
		// One timer: a `start` that armed a check while this decision ran is superseded by the wait.
		if (this.timer) this.clearTimer(this.timer);
		this.timer = this.setTimer(() => {
			this.timer = null;
			this.nextRetryDueAt = null;
			void (async () => {
				// Clear before deciding: another observed busy period must be able to schedule its next
				// bounded retry instead of finding the old wait still marked in flight.
				this.waiting = false;
				try {
					if (!(await this.bounded((signal) => this.deps.refreshPolicy(signal))) || !this.enabled()) {
						this.offline();
						return;
					}
					await this.decide();
				} catch (error) { this.fail(error); }
			})();
		}, IDLE_RETRY_MS);
		this.timer.unref?.();
		this.nextRetryDueAt = this.now() + IDLE_RETRY_MS;
		this.deps.status("waiting-for-idle", latest ? { latestVersion: latest } : undefined);
	}

	private async install(plan: UpdatePlanAction, automatic: boolean): Promise<boolean> {
		if (this.installing) return false;
		this.installing = true;
		try { return await this.deps.installAndRestart(plan, automatic); }
		finally { this.installing = false; }
	}
}

/**
 * A small relay-boundary admission gate. Starting its drain rejects new mutating commands and
 * waits for every mutation already admitted to settle, so the final `/health` observation cannot
 * race a request that was on its way to the local runner when npm finished.
 */
export class RelayMutationAdmission {
	private draining = false;
	private inFlight = 0;
	private waiters: Array<() => void> = [];

	begin(): (() => void) | null {
		if (this.draining) return null;
		this.inFlight++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.inFlight--;
			if (this.inFlight === 0) {
				for (const wake of this.waiters.splice(0)) wake();
			}
		};
	}

	async drain(): Promise<void> {
		this.draining = true;
		if (this.inFlight === 0) return;
		await new Promise<void>((resolve) => this.waiters.push(resolve));
	}

	resume() { this.draining = false; }
}
