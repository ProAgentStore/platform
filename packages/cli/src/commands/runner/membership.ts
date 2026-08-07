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

/** A short, stable label for log lines: enough to recognise, short enough to scan. */
export function instanceLabel(inst: { id: string; name?: string }): string {
	const short = `${inst.id.slice(0, 8)}…`;
	return inst.name ? `${inst.name} (${short})` : short;
}
