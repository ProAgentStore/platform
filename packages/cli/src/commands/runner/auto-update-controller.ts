import { nextAutoUpdateDelayMs, type AutoUpdatePolicy, type AutoUpdateStatus } from "./auto-update.js";
import type { UpdateFacts, UpdateObservation, UpdatePlan } from "./self-update.js";

type UpdatePlanAction = Extract<UpdatePlan, { action: "update" }>;
type Timer = ReturnType<typeof setTimeout>;

export interface AutomaticUpdateControllerDeps {
	policy: () => { value: AutoUpdatePolicy; authoritative: boolean };
	/** Re-registers against the service; false means cached policy is not usable for mutation. */
	refreshPolicy: () => Promise<boolean>;
	facts: () => Promise<UpdateFacts>;
	plan: (facts: UpdateFacts) => UpdatePlan;
	/** The relay's real npm + final-admission + restart bridge. */
	installAndRestart: (plan: UpdatePlanAction, automatic: boolean) => Promise<boolean>;
	status: (status: AutoUpdateStatus, extra?: Partial<AutoUpdatePolicy>) => void;
	setTimer?: (fn: () => void, ms: number) => Timer;
	clearTimer?: (timer: Timer) => void;
	random?: () => number;
	now?: () => number;
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

	constructor(private readonly deps: AutomaticUpdateControllerDeps) {
		this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
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
			if (!(await this.deps.refreshPolicy()) || !this.enabled()) {
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

	private async decide(): Promise<void> {
		const facts = await this.deps.facts();
		this.checkAt = this.now();
		if (facts.observations?.length) this.observations = [...this.observations, ...facts.observations].slice(-MAX_OBSERVATIONS);
		// Authority lost mid-check (a concurrent refresh failed): decide nothing, but keep the retry.
		if (!this.enabled()) return this.offline();
		const plan = this.deps.plan(facts);
		this.decisionAt = this.now();
		this.blockerClass = plan.action === "wait" ? blockerClassFor(plan.waitingFor) : null;
		if (plan.action === "up-to-date") {
			this.failures = 0;
			this.deps.status("verified-success", { latestVersion: facts.latest ?? undefined, reason: undefined });
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
					if (!(await this.deps.refreshPolicy()) || !this.enabled()) {
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
