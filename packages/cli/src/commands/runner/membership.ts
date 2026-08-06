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
export function isEligible(inst: DiscoverableInstance, thisNode: string): boolean {
	if (inst.status !== "active") return false;
	if (inst.capabilities?.runtime == null) return false;
	const pin = inst.config?.runnerNode;
	if (pin && pin !== thisNode) return false;
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
): { attach: DiscoverableInstance[]; detach: string[] } {
	const have = new Set(attached);
	const want = eligible.filter((i) => isEligible(i, thisNode));
	const wantIds = new Set(want.map((i) => i.id));
	return {
		attach: want.filter((i) => !have.has(i.id) && !blocked.has(i.id)),
		// Detach what is no longer eligible — unsubscribed, deactivated, or re-pinned to another
		// machine. Leaving the socket open would keep the agent looking connected here while the
		// platform routes its work elsewhere.
		detach: [...have].filter((id) => !wantIds.has(id)),
	};
}

/** A short, stable label for log lines: enough to recognise, short enough to scan. */
export function instanceLabel(inst: { id: string; name?: string }): string {
	const short = `${inst.id.slice(0, 8)}…`;
	return inst.name ? `${inst.name} (${short})` : short;
}
