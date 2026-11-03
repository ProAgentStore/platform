/**
 * The runner's automatic-update policy record, its channel to the service, and the install/restart bridge (#1020).
 *
 * Moved out of relay.ts so the production sequencing is what the tests drive: the record a restarted process reads
 * back, the registration that confers authority, and every wait between deciding to install and leaving to restart.
 */
import { type Bound, boundedWork, type RelayMutationAdmission } from "./auto-update-controller.js";
import { acceptPolicyResponse, type AutoUpdatePolicy, type AutoUpdateStatus, mayAutomaticallyRestart, ResponseFence } from "./auto-update.js";
import { apiPathSegment } from "./http.js";
import type { DeferredUpdateLease, UpdateFacts, UpdatePlan } from "./self-update.js";

type UpdatePlanAction = Extract<UpdatePlan, { action: "update" }>;

/**
 * The machine's policy record: the owner switch and whether a fresh service answer confirmed it, plus this
 * controller's own status and recovery cycle. Every write is persisted, so a restarted process reads back the cycle
 * it must verify.
 */
export class PolicyCell {
	authoritative = false;
	refreshing = false;
	private readonly fence = new ResponseFence();

	constructor(
		public policy: AutoUpdatePolicy,
		private readonly persist: (policy: AutoUpdatePolicy) => void,
		/** No stable machine id: nothing is persisted and no answer confers authority. */
		private readonly enabled = true,
	) {}

	/** The status writer every update path uses. */
	record(status: AutoUpdateStatus, extra: Partial<AutoUpdatePolicy> = {}): void {
		this.policy = { ...this.policy, ...extra, status, lastAttemptAt: new Date().toISOString() };
		if (this.enabled) this.persist(this.policy);
	}

	/** The number a registration/heartbeat takes as it is SENT. */
	next(): number {
		return this.fence.next();
	}

	/**
	 * Fold one service answer in. It is VALIDATED before it is ordered (#1020): an answer that carries no readable
	 * policy must not advance the fence, or it would suppress a valid older OFF still in flight. The owner's OFF ends
	 * any recovery cycle.
	 */
	accept(response: unknown, sentAs: number): "start" | "cancel" | "keep" | null {
		if (!this.enabled) return null;
		const accepted = acceptPolicyResponse(this.policy, this.authoritative, response);
		if (!accepted || !this.fence.accepts(sentAs)) return null;
		this.policy = accepted.action === "cancel" ? { ...accepted.policy, recovery: undefined } : accepted.policy;
		this.authoritative = true;
		this.persist(this.policy);
		return accepted.action;
	}
}

export interface PolicyChannelDeps {
	cell: PolicyCell;
	/** POST to the service, with the signal reaching fetch (request and body). */
	post: (path: string, body: unknown, signal?: AbortSignal) => Promise<Record<string, unknown>>;
	/** The registration body for one agent. */
	body: (id: string, force: boolean) => Record<string, unknown>;
	force: boolean;
	/** The agents attached right now — a refresh's fallback when no registration is currently held. */
	held: () => Iterable<string>;
	onError: (id: string, message: string) => void;
	onAction: (action: "start" | "cancel") => void;
	/** The service answered a registration or heartbeat — what proves a release on trial (#1141, release-trial.ts). */
	onAnswer?: () => void;
}

/** Registration and the authority-conferring refresh, over one policy cell. */
export function createPolicyChannel(deps: PolicyChannelDeps) {
	const registered = new Set<string>();
	const act = (action: "start" | "cancel" | "keep" | null) => {
		// A disable cancels a deferred automatic install before npm; a start waits for a refresh to finish.
		if (action === "cancel") deps.onAction("cancel");
		else if (action === "start" && !deps.cell.refreshing) deps.onAction("start");
	};
	const accept = (response: unknown, sentAs: number) => {
		act(deps.cell.accept(response, sentAs));
		deps.onAnswer?.();
	};
	const register = async (id: string, force = deps.force, signal?: AbortSignal): Promise<boolean> => {
		const sent = deps.cell.next();
		try {
			const result = await deps.post(`/v1/instances/${apiPathSegment(id)}/runtime`, deps.body(id, force), signal);
			if (signal?.aborted) return false; // abandoned by its bound: its answer confers nothing
			accept(result, sent);
			registered.add(id);
			return true;
		} catch (e) {
			// OUR abort is not the service refusing the registration (#1020): forgetting it left a machine with one
			// agent no id to refresh through, so every later retry gave up without sending any request at all.
			if (signal?.aborted) return false;
			registered.delete(id);
			deps.onError(id, e instanceof Error ? e.message : String(e));
			return false;
		}
	};
	/** A cached policy is only a hint: every unattended check re-registers one agent for a fresh owner decision. */
	const refresh = async (signal?: AbortSignal): Promise<boolean> => {
		const id = (registered.values().next().value as string | undefined) ?? [...deps.held()][0];
		if (!id) return false;
		deps.cell.authoritative = false;
		deps.cell.refreshing = true;
		try {
			// Never `force` (#1172): force SUSPENDS coding sessions owned by other machines, which is what the startup claim of
			// `pags up --force` is for — not something every unattended policy check may repeat. The reconnect path refreshes
			// without it for the same reason; a refresh only needs the owner's current decision.
			return (await register(id, false, signal)) && deps.cell.authoritative;
		} finally {
			deps.cell.refreshing = false;
		}
	};
	return { registered, register, refresh, accept };
}

/** A bridge wait that did not answer within its bound. Thrown AFTER admission and the single flight are released. */
export class BoundExpired extends Error {
	readonly boundExpired = true;
}

export interface InstallBridgeDeps {
	cell: PolicyCell;
	refresh: (signal?: AbortSignal) => Promise<boolean>;
	facts: (signal?: AbortSignal) => Promise<UpdateFacts>;
	install: (version: string) => Promise<void>;
	/** Publish the probed payload only after the final owner-policy and idle admission succeeds. */
	activate?: (version: string) => void;
	admission: RelayMutationAdmission;
	leaseActive: (lease: DeferredUpdateLease) => boolean;
	/** Close every socket before the process leaves. */
	detachAll: () => void;
	log: (line: string) => void;
	/** The short pause that lets a request admitted just before the drain show up in /health. */
	settle?: () => Promise<void>;
	bound?: Bound;
	/** How long the mutation drain may wait for admitted requests to settle (#1169). */
	drainMs?: number;
}

/** A request the local runtime has not answered after this long no longer holds an update hostage. */
export const DEFAULT_DRAIN_MS = 120_000;

/**
 * Install the release, then report that the process may leave to restart (#860, #1008). EVERY wait is bounded
 * (#1020): the policy refresh before npm, the one after it, and the final work look. One that does not answer within
 * its bound releases the mutation drain and the single flight, keeps what npm already installed (a retry does not
 * install it again), never restarts, and throws {@link BoundExpired} — which the controller records as a failed
 * check with a retry. Its late answer reaches nothing.
 */
/** A hold is not an install already in progress: callers must preserve the reason (#1453). */
export type InstallBridgeResult =
	| { kind: "restarting" }
	| { kind: "in-flight" }
	| { kind: "lease-expired" | "policy-unavailable" | "policy-disabled" | "fleet-updating"; installedVersion: string | null }
	| { kind: "work-active"; waitingFor: string[]; installedVersion: string | null };

export function createInstallBridge(deps: InstallBridgeDeps) {
	let inFlight = false;
	let installedPendingRestart: string | null = null;
	const within = <T>(work: (signal: AbortSignal) => Promise<T>) => boundedWork(work, deps.bound);
	const expired = (what: string): never => {
		throw new BoundExpired(`${what} did not answer within ${(deps.bound?.ms ?? 30_000) / 1000}s; nothing restarted, and it will be retried.`);
	};
	const held = (kind: "lease-expired" | "policy-unavailable" | "policy-disabled" | "fleet-updating"): InstallBridgeResult => ({ kind, installedVersion: installedPendingRestart });
	const run = async (plan: UpdatePlanAction, automatic = false, lease?: DeferredUpdateLease): Promise<InstallBridgeResult> => {
		if (inFlight) return { kind: "in-flight" };
		if (lease && !deps.leaseActive(lease)) return held("lease-expired");
		inFlight = true;
		let drained = false;
		let restarting = false;
		try {
			// Cached policy cannot authorize an unattended install. The fresh answer also orders the fleet race.
			if (automatic) {
				const fresh = await within((signal) => deps.refresh(signal));
				if (fresh === null) expired("The owner policy refresh before installing");
				if (!fresh || !deps.cell.authoritative) return held("policy-unavailable");
				if (!deps.cell.policy.autoUpdate) return held("policy-disabled");
				if (deps.cell.policy.fleetUpdating) return held("fleet-updating");
			}
			if (installedPendingRestart !== plan.latest) {
				deps.log(`Updating ${plan.current} → ${plan.latest} (runner_update)…`);
				await deps.install(plan.latest);
				installedPendingRestart = plan.latest;
			}
			// Work admitted while npm ran must survive. Hold new mutations until final restart admission.
			const drainMs = deps.drainMs ?? DEFAULT_DRAIN_MS;
			drained = true;
			if ((await deps.admission.drain(drainMs)) === false) {
				const stuck = deps.admission.pending();
				throw new BoundExpired(`${stuck} local request${stuck === 1 ? " is" : "s are"} still running after ${Math.round(drainMs / 1000)}s, so the restart waited no longer; nothing restarted and it will be retried. A forced runner_restart restarts now.`);
			}
			await (deps.settle ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 500))))();
			if (lease && !deps.leaseActive(lease)) return held("lease-expired");
			if (automatic) {
				const fresh = await within((signal) => deps.refresh(signal));
				if (fresh === null) expired("The owner policy refresh after installing");
				if (!fresh || !deps.cell.authoritative) return held("policy-unavailable");
				if (!deps.cell.policy.autoUpdate) return held("policy-disabled");
			}
			const facts = await within((signal) => deps.facts(signal));
			if (facts === null) return expired("The final local work look before restarting");
			// The final look itself can consume the rest of a deferred operation's lease.
			if (lease && !deps.leaseActive(lease)) return held("lease-expired");
			if (facts.busy.length) return { kind: "work-active", waitingFor: [...facts.busy], installedVersion: installedPendingRestart };
			if (automatic && !mayAutomaticallyRestart({ authoritative: deps.cell.authoritative, enabled: deps.cell.policy.autoUpdate, workObserved: true, busy: facts.busy })) {
				return held(deps.cell.policy.autoUpdate ? "policy-unavailable" : "policy-disabled");
			}
			deps.activate?.(plan.latest);
			deps.log(`Installed ${plan.latest} — restarting; every agent re-attaches on the way back up.`);
			deps.detachAll();
			restarting = true;
			// The caller sends the receipt before exiting; retain the admission gate until then.
			return { kind: "restarting" };
		} finally {
			// Rejections from any dependency must release both guards, not just expected timeout paths (#1453).
			if (!restarting) {
				inFlight = false;
				if (drained) deps.admission.resume();
			}
		}
	};
	return { run, inFlight: () => inFlight, installedPendingRestart: () => installedPendingRestart };
}
