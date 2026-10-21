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
	/** The agents this machine holds right now — attached AND registered. Recorded at install, required back after it (#1020). */
	attachments?: () => readonly string[];
	/**
	 * The agents this machine SHOULD hold right now, per the latest membership pass; null before one has run (#1170). An agent
	 * the owner repinned, paused or unsubscribed since the install is no longer expected back, so it cannot keep a cycle
	 * "N of M" forever.
	 */
	shouldHold?: () => ReadonlySet<string> | null;
}

/** Why an enabled controller is not installing yet — a normalized class, never raw session data (#1020). */
export type BlockerClass = "idle_wait" | "active_sessions" | "observation_failure" | "fleet_stagger" | "unknown";

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

/** The injectable timer a bound runs on, so tests can expire it deterministically. */
export interface Bound {
	timer?: (fn: () => void, ms: number) => Timer;
	clear?: (timer: Timer) => void;
	ms?: number;
}

/**
 * One bounded piece of work (#1020): past its bound the signal is aborted and this resolves null — the race has
 * settled, so a late result reaches nothing. A late rejection is absorbed rather than left unhandled. Shared by the
 * controller's own refresh and facts AND every wait in the install bridge.
 */
export async function boundedWork<T>(work: (signal: AbortSignal) => Promise<T>, bound: Bound = {}): Promise<T | null> {
	const abort = new AbortController();
	let timer: Timer | undefined;
	const expired = new Promise<null>((resolve) => {
		timer = (bound.timer ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
			abort.abort();
			resolve(null);
		}, bound.ms ?? OBSERVATION_TIMEOUT_MS);
		timer.unref?.();
	});
	const running = work(abort.signal);
	running.catch(() => undefined);
	try {
		return await Promise.race([running, expired]);
	} finally {
		if (timer) (bound.clear ?? ((t) => clearTimeout(t)))(timer);
	}
}

/**
 * Whether a check on the latest release VERIFIES an update cycle (#1020), or only finds the runner current.
 * `verified` needs the PERSISTED recovery record of an attempted install (its target and the agents held when it
 * was installed — kept apart from the transient status, so a failed or offline check never forgets it), readable
 * versions with the running one at or past that target, a local work look the guard itself could read (both halves
 * answered, neither malformed), and EVERY original agent attached again. An attempt status with no recovery record
 * comes from an older runner's cache: `unknown`, never verified and never an ordinary no-attempt check.
 */
export function updateVerdict(attempt: AutoUpdatePolicy, facts: UpdateFacts, attachedNow: readonly string[] = [], shouldHold: ReadonlySet<string> | null = null): { kind: "verified" | "current" | "completed" } | { kind: "unverified" | "unknown"; reason: string } {
	if (!isVersion(facts.current) || !isVersion(facts.latest)) return { kind: "unverified", reason: `the running (${facts.current}) or published (${facts.latest}) version could not be read` };
	const cycle = attempt.recovery;
	// A resolved cycle is terminal evidence (#1020): it was verified once and is never re-judged by a later check.
	if (cycle?.verifiedAt) return { kind: "completed" };
	if (!cycle) {
		if (attempt.status === "running" || attempt.status === "restarting") return { kind: "unknown", reason: "an update attempt was recorded by an older runner without the record needed to verify it" };
		return { kind: "current" };
	}
	if (!isVersion(cycle.target)) return { kind: "unverified", reason: `the attempted update's target (${cycle.target}) could not be read` };
	if (olderThan(facts.current, cycle.target)) return { kind: "unverified", reason: `the runner came back on ${facts.current}, not the attempted ${cycle.target}` };
	const observed = facts.observations ?? [];
	if (!observed.length) return { kind: "unverified", reason: `the runner is on ${facts.current}, but no health look was taken` };
	const look = (source: string) => {
		const o = observed.filter((x) => x.source === source).at(-1);
		return !o ? "missing" : o.malformed ? "malformed" : o.success ? "ok" : "failed";
	};
	const sessions = look("sessions");
	const health = look("health");
	if (sessions !== "ok" || health !== "ok" || facts.busy.includes("runner-work-observation-unavailable")) {
		return { kind: "unverified", reason: `the runner is on ${facts.current}, but its local work look was not readable (sessions ${sessions}, health ${health})` };
	}
	const back = new Set(attachedNow);
	// Judged against the agents the machine should hold NOW (#1170): one repinned, paused or unsubscribed since the install is excused.
	const required = shouldHold ? cycle.attachments.filter((id) => shouldHold.has(id)) : cycle.attachments;
	const missing = required.filter((id) => !back.has(id));
	if (missing.length) return { kind: "unverified", reason: `the runner is on ${facts.current}, but only ${required.length - missing.length} of its ${required.length} original agents are attached again` };
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
		this.checkAt = this.now(); // a refresh that failed or timed out is a check that happened (#1020)
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
	private bounded<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
		return boundedWork(work, { timer: this.boundTimer, clear: this.clearTimer });
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
		// An OPEN cycle (installed, not yet verified) owns this machine's update until it resolves (#1020). Once its version
		// is reached it is settled first — whatever the registry now says — and it is never redefined below.
		const policy = this.deps.policy().value;
		let open = policy.recovery && !policy.recovery.verifiedAt ? policy.recovery : undefined;
		const reached = !!open && isVersion(open.target) && isVersion(facts.current) && !olderThan(facts.current, open.target);
		// Current is not the same claim as a verified update cycle (#1020): only an attempted install that came
		// back on its target with a healthy runtime is `verified-success`.
		const verdict = plan.action === "up-to-date" || reached ? updateVerdict(policy, facts, this.deps.attachments?.() ?? [], this.deps.shouldHold?.() ?? null) : null;
		// A newer release SUPERSEDES a cycle that cannot verify (#1170): its target is behind the registry, so keeping it
		// recorded would pin the machine to "N of M" forever. The new install begins its own cycle with the agents held then.
		const superseded = verdict?.kind === "unverified" && (plan.action === "update" || plan.action === "wait");
		if (superseded) open = undefined;
		if (verdict && !superseded) {
			if (verdict.kind === "unverified") {
				// The cycle stays recorded: the retry still knows its target and the agents it must bring back.
				this.failures++;
				this.deps.status("failure", { reason: `Not verified: ${verdict.reason}.` });
			} else if (verdict.kind === "unknown") {
				this.failures = 0;
				this.deps.status("enabled", { latestVersion: facts.latest ?? undefined, reason: `Not verified: ${verdict.reason}.` });
			} else {
				this.failures = 0;
				// A verified cycle is RESOLVED, not erased: it stays as terminal evidence across checks and reloads. A completed
				// one keeps its status; an ordinary check leaves the record exactly as it is.
				const resolved = verdict.kind === "verified" && policy.recovery ? { recovery: { ...policy.recovery, verifiedAt: new Date(this.now()).toISOString() } } : {};
				this.deps.status(verdict.kind === "current" ? "enabled" : "verified-success", { latestVersion: facts.latest ?? undefined, reason: undefined, ...resolved });
			}
			this.schedule();
			return;
		}
		// (An up-to-date plan always has a verdict and cannot be superseded, so it returned above; this narrows the type.)
		if (plan.action === "up-to-date") return;
		if (plan.action === "refused") {
			// A release check that could not run (npm unreachable, or unstartable as on Windows before #1020) is a FAILURE,
			// retried with backoff and visible to the stuck check — not `unsupported`, which says this install can never update.
			if (plan.retryable) this.failures++;
			this.deps.status(plan.retryable ? "failure" : "unsupported", { reason: plan.reason });
			this.schedule();
			return;
		}
		if (plan.action === "wait") {
			this.deps.status("waiting-for-idle", { latestVersion: plan.latest, reason: undefined });
			this.defer();
			return;
		}
		// One machine at a time (#1141): another machine on this account is installing or has not come back yet, so
		// this one waits rather than risk the whole fleet going dark together. Re-checked on the idle cadence.
		if (policy.fleetUpdating) {
			this.blockerClass = "fleet_stagger";
			this.deps.status("waiting-for-idle", { latestVersion: plan.latest, reason: `${policy.fleetUpdating} other machine(s) on this account are mid-update; this one updates after them.` });
			this.defer(plan.latest);
			return;
		}
		// A NEW cycle begins with the install, recorded before npm runs: target + the agents held now (#1020). An OPEN one is
		// retried on its own target with its own agents and start — a shrunken membership or a different registry answer
		// never redefines it, and the bridge then reuses what npm already installed instead of installing again.
		const target = open && isVersion(open.target) ? open.target : plan.latest;
		const attempt = { ...plan, latest: target };
		const recovery = open ?? { target, attachments: [...(this.deps.attachments?.() ?? [])], at: new Date(this.now()).toISOString() };
		this.deps.status("running", { latestVersion: target, reason: undefined, recovery });
		const restarted = await this.install(attempt, true);
		if (restarted) {
			this.deps.status("restarting", { latestVersion: target, reason: undefined });
			return;
		}
		// The final, race-safe admission refused (work began during npm, the policy could not be
		// re-read, another install held the single flight). That refusal stays fail-closed — and it
		// must also be RETRIED, deferred or not (#1020). A deferred callback reaches here with its own
		// timer already spent, so returning without a new one left an enabled runner silent forever:
		// `waiting_for_idle` while idle, with nothing left to re-decide.
		this.blockerClass = this.deps.policy().value.fleetUpdating ? "fleet_stagger" : "idle_wait";
		this.defer(target);
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

	/**
	 * Stop admitting and wait for the admitted mutations to settle. With `maxMs`, the wait is BOUNDED (#1169): one wedged
	 * request must not hold the machine in "draining" forever. Resolves true when drained, false when `maxMs` passed with
	 * work still running — the gate stays closed until the caller decides (`resume()`), and `pending()` says how much.
	 */
	async drain(maxMs?: number): Promise<boolean> {
		this.draining = true;
		if (this.inFlight === 0) return true;
		return new Promise<boolean>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | null = null;
			const wake = () => {
				if (timer) clearTimeout(timer);
				resolve(true);
			};
			this.waiters.push(wake);
			if (maxMs !== undefined) {
				timer = setTimeout(() => {
					this.waiters = this.waiters.filter((w) => w !== wake);
					resolve(false);
				}, maxMs);
				timer.unref?.();
			}
		});
	}

	/** Mutations admitted and not yet settled. */
	pending(): number { return this.inFlight; }

	resume() { this.draining = false; }
}
