// This machine's stable identity (#379).
//
// `os.hostname()` is not one. On macOS it follows the DHCP/network-supplied name and flips
// between the `.local` mDNS form and whatever the network hands out, so one laptop reported
// itself to PAGS as `Mac`, `RLs-MacBook-Air.local` and `RLs-MacBook-Air` on different days. The
// server keyed a machine by that string, so the laptop became three machines, and an agent pinned
// to a name it had stopped using answered every call with "run `pags up`" while `pags up` was
// running on it.
//
// So: mint a UUID ONCE and keep it beside the session, exactly where `pags logout` already
// expects a machine-local file to live. The hostname keeps its job as the routing key and the
// display label — it names a Durable Object on the server and could not be replaced without
// renaming every relay at once — and this id rides alongside it saying which names are one
// machine.
//
// ── Why there is no fallback id
//
// If the file cannot be written, this returns NO id rather than deriving one from the
// environment. A derived id (username + platform + home) collides across two machines of the same
// user, and the server treats a shared id as proof of sameness — it would route an agent pinned
// to one laptop onto the other, which is the precise thing a pin exists to prevent. Failing
// closed costs the healing; guessing costs the guarantee.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".config", "proagentstore");
const MACHINE_FILE = join(CONFIG_DIR, "machine.json");

/** How many past hostnames we remember. Bounds the claim the server acts on. */
export const MAX_NAMES = 10;

/**
 * How many declined names we remember (#460).
 *
 * Purely local — `declined` is never sent anywhere, so unlike `names` its size is not a blast
 * radius. It is bounded only so the file cannot grow without limit on an account that keeps
 * minting hostnames.
 */
export const MAX_DECLINED = 40;

export interface MachineIdentity {
	/** "" when it could not be persisted — the server then does no aliasing at all. */
	id: string;
	/** Hostnames this machine has answered to while running the CLI, most recent first. */
	names: string[];
	/**
	 * Node names the user was OFFERED and said were not this machine (#460).
	 *
	 * The answer has to be remembered somewhere, or a user who genuinely owns three machines is
	 * interrogated at every `pags up`. It is kept beside the identity rather than in a second file
	 * because it answers a question about this machine and nothing else reads it.
	 */
	declined?: string[];
}

/** Where the identity lives — printed when a decision is recorded, so it can be undone by hand. */
export function machineFilePath(): string {
	return MACHINE_FILE;
}

/** Same shape the server validates with (`normalizeMachineId`), checked before it is sent. */
export function isValidMachineId(value: unknown): boolean {
	return typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

/** Read a machine.json body. Anything unrecognisable is treated as absent, not as an error —
 *  a corrupt file must cost the healing, never the ability to start a runner. */
export function parseMachineFile(text: string): MachineIdentity | null {
	try {
		const data = JSON.parse(text) as { id?: unknown; names?: unknown; declined?: unknown };
		if (!isValidMachineId(data.id)) return null;
		return {
			id: data.id as string,
			names: stringList(data.names).slice(0, MAX_NAMES),
			declined: stringList(data.declined).slice(0, MAX_DECLINED),
		};
	} catch {
		return null;
	}
}

/** Trimmed, non-empty strings out of an unknown JSON value. Anything else is simply not there. */
function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((n): n is string => typeof n === "string" && n.trim().length > 0).map((n) => n.trim());
}

/**
 * Record the name this machine is wearing right now, most-recent first.
 *
 * The history is the whole backfill: on the first run the machine can only claim the hostname it
 * already registered under, which changes nothing. The moment the network renames it, the list
 * holds BOTH names — and the server stamps this machine's id onto the row left behind under the
 * old one, which is what reconnects a pin that was already stranded before any of this existed.
 */
export function withName(identity: MachineIdentity | null, name: string): MachineIdentity {
	const current = name.trim();
	const prev = identity?.names ?? [];
	const names = current ? [current, ...prev.filter((n) => n !== current)] : [...prev];
	return { id: identity?.id ?? "", names: names.slice(0, MAX_NAMES), declined: identity?.declined ?? [] };
}

/**
 * Record names the user CONFIRMED are this machine (#460).
 *
 * The claim goes in directly after the current hostname, ahead of the passively-recorded history.
 * `names` is capped, and the cap is what the server acts on: a claim appended at the end of a full
 * list would be silently trimmed away, so the one entry a human actually asserted would be the one
 * that never got sent. A name that was previously declined stops being declined — the later answer
 * is the answer.
 */
export function withClaimedNames(identity: MachineIdentity, claimed: readonly string[]): MachineIdentity {
	const add = claimed.map((n) => n.trim()).filter(Boolean);
	const ordered = [identity.names[0], ...add, ...identity.names.slice(1)].filter((n): n is string => !!n);
	const names: string[] = [];
	for (const n of ordered) if (!names.includes(n)) names.push(n);
	return {
		id: identity.id,
		names: names.slice(0, MAX_NAMES),
		declined: (identity.declined ?? []).filter((n) => !add.includes(n)),
	};
}

/**
 * Remove a name from this machine's claimed list and add it to `declined` (#467).
 *
 * This is the inverse of `withClaimedNames`. A removed name is moved to `declined` so the
 * #460 first-run prompt does not offer it straight back — without that, the next `pags up`
 * would re-stamp the rows and silently undo the un-claim.
 *
 * The current hostname (`names[0]`) is the name the machine is actively registering under; it
 * CANNOT be unclaimed from the local file, because the next register will just re-add it via
 * `withName`. The caller is responsible for rejecting that case.
 */
export function withUnclaimedName(identity: MachineIdentity, name: string): MachineIdentity {
	const unclaim = name.trim();
	if (!unclaim) return identity;
	const names = identity.names.filter((n) => n !== unclaim);
	const declined = [...(identity.declined ?? [])];
	if (!declined.includes(unclaim)) declined.push(unclaim);
	return { id: identity.id, names, declined: declined.slice(-MAX_DECLINED) };
}

/**
 * Record names the user was offered and did NOT claim (#460), so the offer is made once.
 *
 * A name this machine already answers to is never recorded as declined: `names` is the authority,
 * and a decline entry shadowing it would quietly suppress the offer if the claim were ever undone
 * by hand — which is the escape hatch this file is.
 */
export function withDeclinedNames(identity: MachineIdentity, declined: readonly string[]): MachineIdentity {
	const out = [...(identity.declined ?? [])];
	for (const raw of declined) {
		const name = raw.trim();
		if (!name || out.includes(name) || identity.names.includes(name)) continue;
		out.push(name);
	}
	return { id: identity.id, names: identity.names, declined: out.slice(-MAX_DECLINED) };
}

/** Persist an identity. False when the home directory is not writable — never throws: a decision
 *  we cannot remember must cost the memory, not the runner. */
export function saveMachineIdentity(identity: MachineIdentity): boolean {
	try {
		mkdirSync(CONFIG_DIR, { recursive: true });
		writeFileSync(MACHINE_FILE, JSON.stringify(identity, null, 2));
		return true;
	} catch {
		return false;
	}
}

/** Whether a rewrite would change anything on disk. */
function sameIdentity(a: MachineIdentity, b: MachineIdentity): boolean {
	return a.id === b.id
		&& a.names.join("\0") === b.names.join("\0")
		&& (a.declined ?? []).join("\0") === (b.declined ?? []).join("\0");
}

/**
 * This machine's identity, minting and persisting one on first use.
 *
 * Returns `{ id: "", names: [] }` when the file cannot be read AND cannot be written — see the
 * header for why that is deliberately not papered over with a derived id.
 */
export function loadMachineIdentity(now = hostname()): MachineIdentity {
	let stored: MachineIdentity | null = null;
	try {
		if (existsSync(MACHINE_FILE)) stored = parseMachineFile(readFileSync(MACHINE_FILE, "utf-8"));
	} catch {
		/* unreadable — fall through and try to (re)write it */
	}
	const next = withName(stored ?? { id: randomUUID(), names: [] }, now);
	// Write on EVERY start, not just when minting: the name list is what makes a rename heal, and
	// a rename is exactly the event that changes it.
	if (stored && sameIdentity(stored, next)) return next;
	if (saveMachineIdentity(next)) return next;
	// Unwritable home (a locked-down CI box, a read-only container). An id we cannot persist
	// would be new on every start, which is worse than none: it would fragment the machine
	// further rather than merging it.
	return stored ?? { id: "", names: [] };
}
