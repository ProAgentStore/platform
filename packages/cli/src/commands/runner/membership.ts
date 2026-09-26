/**
 * Which instances a running `pags up` should have relay sockets open for, and how that set
 * changes while it runs (#229).
 *
 * `connectViaRelay` used to capture the instance ids as an immutable array at startup, so an
 * agent subscribed afterwards had no socket and no way to get one — the console showed
 * `nodeOnline: true, connected: false` until the user restarted the CLI. These are the pure
 * decisions behind fixing that; the I/O lives in relay.ts.
 */

/** The shape `/v1/instances/my/instances` returns, narrowed to what eligibility needs. */
export interface DiscoverableInstance {
	id: string;
	name?: string;
	status?: string;
	capabilities?: { runtime?: string | null } | null;
	config?: { runnerNode?: string | null } | null;
}

/**
 * Does this instance want a local runner on THIS machine?
 *
 * Two conditions come straight from `up.ts`'s startup filter, so discovery and startup can
 * never disagree about what is eligible: active, and declaring a runtime. The third is new —
 * an instance pinned to a different node belongs to that machine. Attaching it here would
 * either lose a race with the pinned machine or, worse, win one and silently relocate the
 * user's agent away from where they pinned it.
 */
export function isEligible(inst: DiscoverableInstance, thisNode: string, alsoKnownAs: readonly string[] = []): boolean {
	if (inst.status !== "active") return false;
	if (inst.capabilities?.runtime == null) return false;
	const pin = inst.config?.runnerNode;
	// A pin names a HOSTNAME, and `os.hostname()` moves under the machine — DHCP, a VPN, the
	// `.local` mDNS form (#379). So "pinned elsewhere" and "pinned here under the name I had
	// yesterday" look identical unless this machine says which names are its own. Without
	// `alsoKnownAs`, a rename made the poll DETACH the very agent the user pinned to this laptop,
	// twenty seconds after `pags up` attached it — and the server then had no socket to resolve
	// the pin onto, which is the half of the fix that cannot live on the server.
	if (pin && pin !== thisNode && !alsoKnownAs.includes(pin)) return false;
	return true;
}

/**
 * What changed between the sockets we hold and the instances we should hold sockets for.
 *
 * `blocked` ids are excluded from `attach` — an instance another live runner owns answers the
 * relay handshake with 4409, and retrying it every poll turns a permanent conflict into an
 * endless reconnect log. They are NOT dropped from the eligible set, so clearing the block
 * (the other machine disconnects, or the user runs --force) lets the next pass attach.
 */
export function diffMembership(
	attached: Iterable<string>,
	eligible: DiscoverableInstance[],
	thisNode: string,
	blocked: ReadonlySet<string> = new Set(),
	/** Hostnames this machine has also answered to, so a pin made under one still points here. */
	alsoKnownAs: readonly string[] = [],
): { attach: DiscoverableInstance[]; detach: string[] } {
	const have = new Set(attached);
	const want = eligible.filter((i) => isEligible(i, thisNode, alsoKnownAs));
	const wantIds = new Set(want.map((i) => i.id));
	return {
		attach: want.filter((i) => !have.has(i.id) && !blocked.has(i.id)),
		// Detach what is no longer eligible — unsubscribed, deactivated, or re-pinned to another
		// machine. Leaving the socket open would keep the agent looking connected here while the
		// platform routes its work elsewhere.
		detach: [...have].filter((id) => !wantIds.has(id)),
	};
}

/**
 * Does a socket that just opened have to (re)register the runtime? (#497)
 *
 * `registerRuntime` was called at startup and when discovery ATTACHED a new instance, and nowhere
 * else — `openRelaySocket` never touched it. So the socket, the one thing here that retries, came
 * back after a laptop woke and the runtime registration did not: a live relay, no
 * `instance_runtime_nodes` row for this machine, and `resumeSessionsForNode` (which lives inside
 * that route) never running, so this machine's own suspended coding sessions stayed suspended.
 *
 * Two cases, one rule. A RECONNECT always re-registers — that is the wake path, and the upsert is
 * idempotent. A FIRST open re-registers only when the earlier attempt failed, which is the other
 * half of the same bug: a register that lost a race with the network coming up ("fetch failed" at
 * boot) was caught, logged, and never retried by anything.
 */
export function shouldRegisterOnOpen(reconnect: boolean, alreadyRegistered: boolean): boolean {
	return reconnect || !alreadyRegistered;
}

/**
 * Attached instances whose runtime registration never took — the retry nothing else owes them (#497).
 *
 * `registerRuntime` has exactly three callers: the startup loop, a discovery ATTACH, and a socket
 * (re)open. None of them can reach an instance whose SOCKET is up and whose REGISTRATION failed:
 * discovery's `attach` set excludes anything already attached, and `onOpen` only fires again if the
 * socket drops — which, for a machine that stays awake, it may never do.
 *
 * That is §1a of #497 one layer down. The first fix made the register ride the reconnect, so a
 * wake recovers; this covers the case where the wake's own register is the thing that failed
 * (the API is briefly unreachable while the relay's CDN edge is already answering, which is exactly
 * the asymmetry the original screenshot showed: "Secure link connected · ProAgentStore not
 * registered"). The upsert is idempotent, so retrying costs one POST per broken instance per poll
 * and nothing at all when registration is healthy.
 */
export function pendingRegistrations(attached: Iterable<string>, registered: ReadonlySet<string>): string[] {
	return [...attached].filter((id) => !registered.has(id));
}

/**
 * Split what `pags up` fetched into what THIS machine serves and what is pinned elsewhere (#810).
 *
 * The same rule discovery applies 20 seconds later, applied at the start — so an agent pinned to
 * another machine is never attached, never force-registered (which would suspend that machine's
 * coding sessions), and never counted against this machine's "registered N/M". Before this the
 * startup list was every runtime agent on the account, discovery detached the pinned-elsewhere
 * ones on its first pass, and the denominator kept the original count — so the screen read
 * "Still connecting" for the life of the process on any account with two machines.
 */
export function partitionByPin<T extends DiscoverableInstance>(
	instances: readonly T[],
	thisNode: string,
	alsoKnownAs: readonly string[] = [],
): { here: T[]; elsewhere: T[] } {
	const here: T[] = [];
	const elsewhere: T[] = [];
	for (const inst of instances) (isEligible(inst, thisNode, alsoKnownAs) ? here : elsewhere).push(inst);
	return { here, elsewhere };
}

/**
 * The agents this runner holds whose pin now names ANOTHER machine (#853 finding 13) — what a scoped
 * run lets go of when a repin asks. Only the pin: an agent pinned here (under any of this machine's
 * names), unpinned, or not in the listing at all is kept, because a scoped run was started for it.
 */
export function pinnedAway(held: Iterable<string>, instances: readonly DiscoverableInstance[], thisNode: string, alsoKnownAs: readonly string[] = []): string[] {
	const pins = new Map(instances.map((i) => [i.id, i.config?.runnerNode]));
	return [...held].filter((id) => {
		const pin = pins.get(id);
		return !!pin && pin !== thisNode && !alsoKnownAs.includes(pin);
	});
}

/**
 * What the registration light should say, from the LIVE attached set (#810).
 *
 * The denominator is what this machine currently serves — not the list it was started with.
 * Detaching an agent (a pin moved, an unsubscribe) must not leave the light "partial" forever
 * for an agent nobody expects this machine to hold.
 */
export function registrationStatus(attached: Iterable<string>, registered: ReadonlySet<string>): { agents: string; state: "ok" | "partial" | "fail" } {
	const ids = [...attached];
	const have = ids.filter((id) => registered.has(id)).length;
	const total = ids.length;
	return { agents: `${have}/${total}`, state: have === total ? "ok" : have === 0 ? "fail" : "partial" };
}

/** A short, stable label for log lines: enough to recognise, short enough to scan. */
export function instanceLabel(inst: { id: string; name?: string }): string {
	const short = `${inst.id.slice(0, 8)}…`;
	return inst.name ? `${inst.name} (${short})` : short;
}

/** What the cloud's body on a membership-sync command asks for (#856). Every field optional. */
export interface ReattachRequest {
	/** One agent to (re)attach NOW — the relay has no live socket for it. */
	attach?: unknown;
	/** Take that agent's slot even if another socket answers there: `pags up --force`, for one agent. */
	force?: unknown;
}

/** How one control request changes the runner's own state — decided here, applied by the relay. */
export interface ReattachPlan {
	/** The agent the request names, or null for a plain membership sync. */
	target: string | null;
	/** Drop it from `blocked`: the conflict that blocked it is what the cloud just cleared. */
	unblock: boolean;
	/** Close the handle held for it — the cloud asked BECAUSE it is not delivering a live socket. */
	detach: boolean;
	/** Open its next socket with `force=1`. */
	force: boolean;
	/** A scoped run (`--instance`) that does not serve this agent refuses, with this sentence. */
	refuse?: string;
	/** A scoped run given a plain sync: let go of what the pin moved away, attach nothing (#853 finding 13). */
	release?: true;
}

/**
 * The remote equivalent of `pags up --force`, scoped to one agent (#856).
 *
 * A runner can hold a handle for an agent that delivers nothing — its socket was evicted as stale,
 * or it lost a 4409 and BLOCKED the agent for the life of the process. Both used to need a person
 * at the machine. Here the cloud names the agent, and the runner lets go of whatever it holds for
 * it and attaches it afresh. A scoped run takes the request only for the agent it was started for.
 */
export function reattachPlan(request: ReattachRequest | undefined, state: { held: boolean; blocked: boolean; watching: boolean; scope: readonly string[] }): ReattachPlan {
	const target = typeof request?.attach === "string" && request.attach ? request.attach : null;
	const force = target !== null && request?.force === true;
	// A plain sync is what a repin sends the machine it moves an agent AWAY from (#853 finding 13). A
	// scoped run refused it, so a `pags up --instance X` held X — socket and heartbeat — forever after
	// X was pinned elsewhere. Letting go only narrows the scope; nothing is attached.
	if (!state.watching && !target) return { target, unblock: false, detach: false, force: false, release: true };
	if (!state.watching && !(target && state.scope.includes(target))) {
		return {
			target,
			unblock: false,
			detach: false,
			force: false,
			refuse: "This machine's `pags up` was started with --instance, so it serves only that agent. Restart it without --instance to let it take repinned agents.",
		};
	}
	return { target, unblock: target !== null && state.blocked, detach: target !== null && state.held, force };
}
