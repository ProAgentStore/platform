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

// ── Which id a NAME resolves to, and the names one machine answers to (#393) ────────────────

/**
 * hostname → the machine id every row under that name carries, when they agree.
 *
 * There is one row per (instance, hostname), and a `pags up` stamps the id only on the instances
 * it registers this session — an instance it did not attach keeps NULL under the very same
 * hostname. So identity has to be resolved across a name's rows before anything is grouped, or a
 * machine splits in two whenever the identified row is read first and folds nothing when the NULL
 * one is.
 *
 * Only when the name is UNAMBIGUOUS. A hostname is not an identity and must never transfer one:
 * two laptops both called `Mac`, each serving different instances, are two machines, and merging
 * them is the failure the fold exists to prevent, in mirror image. A name carrying more than one
 * id gets NO entry — the honest answer, not a guess.
 */
export function adoptableIdByName(rows: readonly NodeRegistration[]): Map<string, string> {
	const idsForName = new Map<string, Set<string>>();
	for (const row of rows) {
		const node = normalizeRunnerNode(row.node);
		const id = normalizeMachineId(row.machineId);
		if (!node || !id) continue;
		const set = idsForName.get(node) ?? new Set<string>();
		set.add(id);
		idsForName.set(node, set);
	}
	const out = new Map<string, string>();
	for (const [node, ids] of idsForName) if (ids.size === 1) out.set(node, [...ids][0]);
	return out;
}

/** Every hostname a machine answers to, or why the question cannot be answered about it. */
export type MachineNameSet =
	| { ok: true; names: string[]; machineId: string | null }
	| { ok: false; reason: "unknown" | "ambiguous" };

/**
 * The full set of hostnames that are provably the SAME machine as `target` (including `target`).
 *
 * This is what "forget this machine" has to operate on. Forgetting one name of a folded machine
 * would be a PARTIAL forget — the tile stays on screen under its other names, minus some of its
 * registrations — which is worse than not offering the button, so the unit is the machine.
 *
 * Two refusals rather than a guess, both for the same reason the fold has them:
 *   `unknown`   — no registration under that name; there is nothing to forget.
 *   `ambiguous` — the name carries two different ids, i.e. two laptops are called this. Acting on
 *                 it would delete rows belonging to a machine the user did not point at.
 *
 * A name with no id at all is a machine of exactly one name — that is the fail-closed reading the
 * whole of #379 applies, and here it is also the correct one: without proof of a rename there is
 * no second name to sweep up.
 */
export function machineNamesFor(target: string, rows: readonly NodeRegistration[]): MachineNameSet {
	const name = normalizeRunnerNode(target);
	if (!name) return { ok: false, reason: "unknown" };

	const known = new Set(rows.map((r) => normalizeRunnerNode(r.node)).filter(Boolean));
	if (!known.has(name)) return { ok: false, reason: "unknown" };

	const explicit = new Set<string>();
	for (const row of rows) {
		if (normalizeRunnerNode(row.node) !== name) continue;
		const id = normalizeMachineId(row.machineId);
		if (id) explicit.add(id);
	}
	if (explicit.size > 1) return { ok: false, reason: "ambiguous" };
	const machineId = explicit.size === 1 ? [...explicit][0] : "";
	if (!machineId) return { ok: true, names: [name], machineId: null };

	const byName = adoptableIdByName(rows);
	const names: string[] = [];
	for (const candidate of known) if (byName.get(candidate) === machineId && !names.includes(candidate)) names.push(candidate);
	if (!names.includes(name)) names.push(name);
	return { ok: true, names, machineId };
}

// ── "Why has nothing merged?" — an old CLI cannot be identified (#393) ──────────────────────

/**
 * The first CLI that mints a machine id and sends it (#379 bumped 0.4.39 → 0.4.40).
 *
 * A runner older than this registers with no id at all, so its rows can never be folded and never
 * be claimed. From the console that is indistinguishable from a runner that HAS the feature and
 * found nothing to merge — the fix looks like it did nothing. Naming the version turns an
 * invisible no-op into an instruction.
 */
export const MACHINE_ID_MIN_CLI = "0.4.40";

/** Numeric-part compare, -1/0/1. Unparseable → null, so a caller must decide what to say. */
export function compareCliVersions(a: string, b: string): number | null {
	const parse = (v: string): number[] | null => {
		const parts = String(v ?? "").trim().replace(/^v/, "").split(".");
		if (parts.length < 2) return null;
		const nums = parts.slice(0, 3).map((p) => Number.parseInt(p, 10));
		return nums.every((n) => Number.isInteger(n) && n >= 0) ? nums : null;
	};
	const left = parse(a);
	const right = parse(b);
	if (!left || !right) return null;
	for (let i = 0; i < 3; i++) {
		const d = (left[i] ?? 0) - (right[i] ?? 0);
		if (d !== 0) return d < 0 ? -1 : 1;
	}
	return 0;
}

/**
 * Why this machine has no identity — or null when it has one, or when we cannot honestly say.
 *
 * Three cases, and the distinction between the last two is the point. Telling a user on a CURRENT
 * CLI to upgrade would send them to do the one thing that cannot help, which is the exact failure
 * #379 was reported as ("the one remedy the platform offers is the one thing the user has already
 * done"). An unparseable version says nothing at all rather than guessing.
 */
export function identityHint(machineId: string | null, runnerVersion: string | null): string | null {
	if (normalizeMachineId(machineId)) return null;
	const version = String(runnerVersion ?? "").trim();
	const cmp = compareCliVersions(version, MACHINE_ID_MIN_CLI);
	if (cmp === null) return null;
	if (cmp < 0) return `This machine's CLI is ${version} — upgrade to ${MACHINE_ID_MIN_CLI} or newer and restart \`pags up\` so it can be merged with its other names.`;
	return `This machine's CLI (${version}) can identify itself but did not — \`pags up\` could not save its id file. Check that \`~/.config/proagentstore/\` is writable, then restart it.`;
}
