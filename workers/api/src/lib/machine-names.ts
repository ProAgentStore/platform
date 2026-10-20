/**
 * An owner-set display name per physical machine (#1250), unique per account.
 *
 * A hostname is not a name: macOS renames a machine per network, so one laptop answered to six
 * hostnames and its instances were pinned under four of them. The display name is stored on
 * `machine_policies` beside the stable (user_id, machine_id) the CLI mints once, so a hostname change
 * never touches it and renaming never touches a pin (pins hold the machine id). Unique
 * case-insensitively per owner, because a pin given BY name must resolve to exactly one machine.
 */
import type { Env } from "../types.js";
import { normalizeMachineId } from "./runtime-nodes.js";

export const DISPLAY_NAME_MAX = 40;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

/** A valid name, `null` to clear (blank), or why it is not one. */
export function parseDisplayName(raw: unknown): { ok: true; name: string | null } | { ok: false; error: string } {
	if (raw === null) return { ok: true, name: null };
	if (typeof raw !== "string") return { ok: false, error: "display_name must be a string (blank clears it)." };
	const name = raw.trim().replace(/\s+/g, " ");
	if (!name) return { ok: true, name: null };
	if (name.length > DISPLAY_NAME_MAX || !NAME_RE.test(name)) return { ok: false, error: `display_name must be 1-${DISPLAY_NAME_MAX} characters: letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit.` };
	return { ok: true, name };
}

/** Every named machine of this owner: machine id → display name. */
export async function machineDisplayNames(env: Pick<Env, "DB">, userId: string): Promise<Map<string, string>> {
	const { results } = await env.DB.prepare("SELECT machine_id, display_name FROM machine_policies WHERE user_id = ?1 AND display_name IS NOT NULL")
		.bind(userId)
		.all<{ machine_id: string; display_name: string }>();
	return new Map((results ?? []).map((r) => [r.machine_id, r.display_name]));
}

/** The machine an owner calls `name` (case-insensitive), or null. */
export async function machineIdForDisplayName(env: Pick<Env, "DB">, userId: string, name: string): Promise<string | null> {
	const row = await env.DB.prepare("SELECT machine_id FROM machine_policies WHERE user_id = ?1 AND lower(display_name) = lower(?2)")
		.bind(userId, name.trim())
		.first<{ machine_id: string }>();
	return row?.machine_id ?? null;
}

/**
 * Name (or, with a blank name, un-name) one machine. Refused with 409 when another of the owner's
 * machines already has the name — checked first so the refusal can say which, and enforced by the
 * unique index so two concurrent renames cannot both win.
 */
export async function setMachineDisplayName(
	env: Pick<Env, "DB">,
	userId: string,
	rawMachineId: string,
	rawName: unknown,
): Promise<{ ok: true; displayName: string | null } | { ok: false; status: 400 | 409; error: string }> {
	const machineId = normalizeMachineId(rawMachineId);
	if (!machineId) return { ok: false, status: 400, error: "A stable machine id is required to name a machine." };
	const parsed = parseDisplayName(rawName);
	if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
	if (parsed.name) {
		const holder = await machineIdForDisplayName(env, userId, parsed.name);
		if (holder && holder !== machineId) return { ok: false, status: 409, error: `"${parsed.name}" already names your machine ${holder}. Display names are unique per account — rename that one first.` };
	}
	try {
		await env.DB.prepare(
			`INSERT INTO machine_policies (user_id, machine_id, display_name, updated_at) VALUES (?1, ?2, ?3, ?4)
			 ON CONFLICT(user_id, machine_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`,
		)
			.bind(userId, machineId, parsed.name, Date.now())
			.run();
	} catch (error) {
		if (/UNIQUE/i.test(String(error))) return { ok: false, status: 409, error: `"${parsed.name}" already names another of your machines.` };
		throw error;
	}
	return { ok: true, displayName: parsed.name };
}
