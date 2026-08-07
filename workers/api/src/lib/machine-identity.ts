// What IS a machine? (#379)
//
// ── The defect, in one line
//
// `runner_node` is `os.hostname()`. On macOS that follows the DHCP/network-supplied name and
// flips between the `.local` mDNS form and whatever the network hands out, so ONE laptop minted
// three identities — `Mac`, `RLs-MacBook-Air.local`, `RLs-MacBook-Air` — and an instance pinned
// to a name it had stopped using answered every runner call with "run `pags up`" while `pags up`
// was running on it, with sixteen live sockets.
//
// ── Why the hostname is NOT simply replaced with an id
//
// `runner_node` is not a label. `relayNameForInstance(instanceId, node)` → `${id}:node:${node}`
// NAMES A DURABLE OBJECT, and the same string keys `instance_runtime_nodes`,
// `coding_sessions.runner_node` and `config.runnerNode` pins. Swapping it for a UUID renames every
// relay DO at once: an already-running `pags up` keeps connecting to the hostname-named DO while
// the server looks for the id-named one, and every instance on every machine goes unreachable
// until both halves of the fleet are upgraded — a self-inflicted outage of the exact kind this
// ticket is about.
//
// So identity is ADDITIVE. The hostname stays the routing key and the display label; a stable
// `machine_id`, minted once by the CLI and persisted beside its credentials, rides ALONGSIDE it
// and says which names are the same machine. Nothing is renamed, so an old CLI (which sends no
// id) behaves exactly as it does today.
//
// ── What the id buys, and the line it must not cross
//
// `getBoundRunnerConn` treats a pin as authoritative and deliberately does NOT fall back to
// another machine — falling back would run the agent "on a machine the user did not choose, in a
// different checkout". That contract is untouched here. A hostname change used to be
// indistinguishable, at the server, from the user genuinely moving to a second machine, so
// nothing could safely infer intent. With a persisted id it is no longer an inference: two node
// names carrying the SAME `machine_id` are one machine, as a recorded fact. Routing a dead pin to
// a proven alias of the SAME machine honours the pin; it does not fall back from it.
//
// A row with no `machine_id` (written before this landed, or by an older CLI) yields NO alias.
// Unknown identity fails closed — never a heal we cannot prove.
import { normalizeRunnerNode } from "./runtime-nodes.js";

/** One `instance_runtime_nodes` row, reduced to the identity question. */
export interface NodeRegistration {
	/** The mutable NAME the machine reported (`os.hostname()`) — also the relay DO key. */
	node: string;
	/** The stable id the machine persists. Null on rows written before #379, or by an old CLI. */
	machineId: string | null;
	/** Which instance this registration belongs to — only a node registered for THIS instance
	 *  carries the endpoint + token a runner call needs, so a candidate without one is unroutable. */
	instanceId?: string | null;
	lastSeenAt?: string | null;
}

/** How many previously-used hostnames a machine may claim in one registration. */
export const MAX_MACHINE_NAMES = 10;

/**
 * A machine id is opaque to the server — it only ever compares two of them — so the only rules
 * are length and a character set that cannot smuggle anything into a log or a query.
 */
export function normalizeMachineId(value: unknown): string {
	const raw = String(value ?? "").trim();
	return /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw : "";
}

/**
 * The hostnames a machine claims to have used, for the backfill in `claimMachineNames`.
 *
 * Bounded and de-duplicated: this list authorises a write over rows the user already owns, so its
 * size is the blast radius and it must not be caller-controlled.
 */
export function sanitizeMachineNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const entry of value) {
		const node = normalizeRunnerNode(entry);
		if (node && !out.includes(node)) out.push(node);
		if (out.length >= MAX_MACHINE_NAMES) break;
	}
	return out;
}

/** D1 writes `YYYY-MM-DD HH:MM:SS` in UTC with no zone marker; `Date.parse` would read local. */
function stampMs(value: string | null | undefined): number {
	if (!value) return 0;
	return Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`) || 0;
}

/**
 * Other node NAMES that are provably the same machine as `pinned`, freshest first.
 *
 * Empty whenever the proof is missing — the pinned name has no recorded `machine_id`, or nothing
 * else carries it. That is the fail-closed half: an unprovable rename is reported to the user
 * (see `diagnoseAttachment`'s `pinned-machine-offline`) rather than guessed at.
 *
 * `instanceId`, when given, drops candidates registered only for OTHER instances: routing needs
 * this instance's own endpoint + token row on that node, so a name we cannot reach is not a
 * candidate, it is a red herring.
 */
export function aliasNodesFor(
	pinned: string,
	rows: readonly NodeRegistration[],
	instanceId?: string | null,
): string[] {
	const pin = normalizeRunnerNode(pinned);
	if (!pin) return [];

	const ids = new Set<string>();
	for (const row of rows) {
		if (normalizeRunnerNode(row.node) !== pin) continue;
		const id = normalizeMachineId(row.machineId);
		if (id) ids.add(id);
	}
	if (!ids.size) return [];

	const found: { node: string; at: number }[] = [];
	// `pin` is pre-seeded: the caller has already tried it and it was not live, so re-offering it
	// as its own alias would only cost a second relay probe for an answer we have.
	const seen = new Set<string>([pin]);
	for (const row of rows) {
		const node = normalizeRunnerNode(row.node);
		if (!node || seen.has(node)) continue;
		if (!ids.has(normalizeMachineId(row.machineId))) continue;
		if (instanceId && row.instanceId && row.instanceId !== instanceId) continue;
		seen.add(node);
		found.push({ node, at: stampMs(row.lastSeenAt) });
	}
	return found.sort((a, b) => b.at - a.at).map((f) => f.node);
}

/**
 * Collapse the names of one machine into a single entry, freshest name winning.
 *
 * The reported screen was "RLs-MacBook-Air twice, both offline" — the picker renders one tile per
 * `runner_node` string, so a renamed laptop is three machines to choose between, two of which can
 * never come back. Names with no id stay separate: without the proof they ARE separate, as far as
 * anything here can tell.
 */
export function foldNodesByMachine<T extends NodeRegistration>(rows: readonly T[]): T[] {
	const byId = new Map<string, T>();
	const out: T[] = [];
	for (const row of rows) {
		const id = normalizeMachineId(row.machineId);
		if (!id) {
			out.push(row);
			continue;
		}
		const prev = byId.get(id);
		if (!prev) {
			byId.set(id, row);
			out.push(row);
			continue;
		}
		// Keep the position of the first sighting (callers order these deliberately) and only
		// upgrade the NAME when a fresher registration carries a different one.
		if (stampMs(row.lastSeenAt) > stampMs(prev.lastSeenAt)) {
			byId.set(id, row);
			out[out.indexOf(prev)] = row;
		}
	}
	return out;
}
