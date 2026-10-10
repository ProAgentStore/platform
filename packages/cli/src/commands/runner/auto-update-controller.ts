import { nextAutoUpdateDelayMs, type AutoUpdatePolicy, type AutoUpdateStatus } from "./auto-update.js";
import type { UpdateFacts, UpdatePlan } from "./self-update.js";

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
	private readonly setTimer: (fn: () => void, ms: number) => Timer;
	private readonly clearTimer: (timer: Timer) => void;

	constructor(private readonly deps: AutomaticUpdateControllerDeps) {
		this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
	}

	/** Called only for a true policy transition. `keep` deliberately leaves a due heartbeat timer alone. */
	onPolicy(action: "start" | "cancel" | "keep") {
		if (action === "cancel") return this.cancel();
		if (action === "start") this.schedule(true);
	}

	/** Testable immediate entry point; production reaches it through the scheduled timer. */
	async runNow(): Promise<void> {
		const current = this.deps.policy();
		if (this.checking || this.waiting || !current.authoritative || !current.value.autoUpdate) return;
		this.checking = true;
		try {
			if (!(await this.deps.refreshPolicy()) || !this.enabled()) {
				this.deps.status("offline", { reason: "The owner policy could not be refreshed; automatic update is deferred." });
				return;
			}
			await this.decide(false);
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

	private enabled(): boolean {
		const { value, authoritative } = this.deps.policy();
		return authoritative && value.autoUpdate;
	}

	private schedule(initial = false) {
		if (!this.enabled() || this.timer || this.waiting) return;
		const delay = initial ? Math.round(5_000 + (this.deps.random ?? Math.random)() * 25_000) : nextAutoUpdateDelayMs(this.failures, this.deps.random);
		this.timer = this.setTimer(() => { this.timer = null; void this.runNow(); }, delay);
		this.timer.unref?.();
	}

	private cancel() {
		if (this.timer) this.clearTimer(this.timer);
		this.timer = null;
	}

	private fail(error: unknown) {
		this.failures++;
		this.deps.status("failure", { reason: error instanceof Error ? error.message : String(error) });
		this.schedule();
	}

	private async decide(deferred: boolean): Promise<void> {
		const facts = await this.deps.facts();
		if (!this.enabled()) return;
		const plan = this.deps.plan(facts);
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
		if (restarted) this.deps.status("restarting", { latestVersion: plan.latest, reason: undefined });
		else if (!deferred) this.defer(plan.latest);
	}

	private defer(latest?: string) {
		if (this.waiting) return;
		this.waiting = true;
		this.timer = this.setTimer(() => {
			this.timer = null;
			void (async () => {
				// Clear before deciding: another observed busy period must be able to schedule its next
				// bounded retry instead of finding the old wait still marked in flight.
				this.waiting = false;
				try {
					if (!(await this.deps.refreshPolicy()) || !this.enabled()) {
						this.deps.status("offline", { reason: "The owner policy could not be refreshed; automatic update is deferred." });
						return;
					}
					await this.decide(true);
				} catch (error) { this.fail(error); }
			})();
		}, 15_000);
		this.timer.unref?.();
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
