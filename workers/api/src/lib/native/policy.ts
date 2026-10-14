/**
 * Per-machine owner opt-in for the `local_native` runtime (#1057, slice 1).
 *
 * Native desktop control acts as the owner across EVERYTHING on a machine — every signed-in app,
 * not one browser tab — and Maestro drives the owner's phone or emulator. So the switch is per
 * (owner, machine), off by default, and separate per backend. Enabling either requires the owner to
 * acknowledge the account-risk disclosure below; the acknowledged version is stored, and an opt-in
 * given under an older version stops counting the moment the disclosure is revised.
 *
 * Disabling never needs an acknowledgement: turning a power OFF must always be one step.
 */
import { normalizeMachineId } from "../machine-identity.js";
import type { Env } from "../../types.js";
import type { NativeBackend } from "./contract.js";

/** The disclosure an owner must acknowledge before any native control is enabled on a machine. */
export const NATIVE_RISK_DISCLOSURE_V1 = {
	version: "2026-10-14.v1",
	title: "Before you let an agent control apps on this machine",
	text: [
		"Desktop control lets an agent see this machine's screen and, in later steps, operate its apps as you — every app you are signed in to, not just one website. Maestro control does the same on a connected phone, emulator or simulator.",
		"Many apps forbid automation in their terms of service and actively detect it. WeChat in particular: Tencent prohibits bots and unofficial automation and bans accounts it catches — temporarily or permanently — even when the automation only reads. Other messaging, banking and social apps may do the same.",
		"Use a secondary account, or read-only use, for any app whose terms forbid automation. Never point it at an account you cannot afford to lose.",
		"Reading and looking are allowed; anything consequential — sending as you, paying, submitting, deleting, changing settings — will stop for your approval, and sign-ins, 2FA and QR scans are handed to you. You can turn this off for this machine at any time.",
	].join("\n\n"),
} as const;

export interface NativeOptIn {
	machineId: string;
	desktop: boolean;
	maestro: boolean;
	/** The disclosure version the owner acknowledged, or null if never. */
	disclosureVersion: string | null;
	/** Is that the CURRENT disclosure? An opt-in under an older one does not count. */
	disclosureCurrent: boolean;
	optedInAt: number | null;
}

/** Is this backend enabled on this machine RIGHT NOW (switch on, and under the current disclosure)? */
export const nativeBackendEnabled = (o: NativeOptIn, backend: NativeBackend): boolean => o.disclosureCurrent && (backend === "desktop" ? o.desktop : o.maestro);
export const nativeAnyEnabled = (o: NativeOptIn): boolean => nativeBackendEnabled(o, "desktop") || nativeBackendEnabled(o, "maestro");

export async function getNativeOptIn(env: Pick<Env, "DB">, userId: string, rawMachineId: string | null | undefined): Promise<NativeOptIn | null> {
	const machineId = normalizeMachineId(rawMachineId);
	if (!machineId) return null;
	const row = await env.DB.prepare(
		"SELECT native_desktop_enabled AS d, native_maestro_enabled AS m, native_risk_disclosure_version AS v, native_opted_in_at AS t FROM machine_policies WHERE user_id = ?1 AND machine_id = ?2",
	)
		.bind(userId, machineId)
		.first<{ d: number | null; m: number | null; v: string | null; t: number | null }>();
	return {
		machineId,
		desktop: row?.d === 1,
		maestro: row?.m === 1,
		disclosureVersion: row?.v ?? null,
		disclosureCurrent: row?.v === NATIVE_RISK_DISCLOSURE_V1.version,
		optedInAt: row?.t ?? null,
	};
}

export type SetNativeOptInResult =
	| { ok: true; optIn: NativeOptIn }
	| { ok: false; status: 400; code: "NATIVE_DISCLOSURE_REQUIRED" | "NATIVE_DISCLOSURE_OUTDATED" | "NATIVE_INVALID_REQUEST"; error: string };

/**
 * Turn desktop and/or Maestro control on or off for one machine. A field left undefined keeps its
 * current value. ENABLING requires `acknowledgedDisclosureVersion` to equal the current disclosure.
 */
export async function setNativeOptIn(
	env: Pick<Env, "DB">,
	userId: string,
	rawMachineId: string,
	input: { desktop?: boolean; maestro?: boolean; acknowledgedDisclosureVersion?: string | null },
): Promise<SetNativeOptInResult> {
	const machineId = normalizeMachineId(rawMachineId);
	if (!machineId) return { ok: false, status: 400, code: "NATIVE_INVALID_REQUEST", error: "A stable machine id is required." };
	if (input.desktop === undefined && input.maestro === undefined) return { ok: false, status: 400, code: "NATIVE_INVALID_REQUEST", error: "Set desktop and/or maestro (true or false)." };
	const current = (await getNativeOptIn(env, userId, machineId))!;
	const desktop = input.desktop ?? current.desktop;
	const maestro = input.maestro ?? current.maestro;
	const enabling = (input.desktop === true) || (input.maestro === true);
	if (enabling) {
		const ack = input.acknowledgedDisclosureVersion;
		if (!ack) return { ok: false, status: 400, code: "NATIVE_DISCLOSURE_REQUIRED", error: `Enabling native control needs the account-risk disclosure acknowledged: pass acknowledged_disclosure_version "${NATIVE_RISK_DISCLOSURE_V1.version}" after showing the owner its text.` };
		if (ack !== NATIVE_RISK_DISCLOSURE_V1.version) return { ok: false, status: 400, code: "NATIVE_DISCLOSURE_OUTDATED", error: `That disclosure version (${ack}) is not the current one (${NATIVE_RISK_DISCLOSURE_V1.version}). Show the owner the current text and acknowledge it.` };
	}
	const now = Date.now();
	// An upsert on the existing policy row; a new row keeps every auto-update default (OFF).
	await env.DB.prepare(
		`INSERT INTO machine_policies (user_id, machine_id, native_desktop_enabled, native_maestro_enabled, native_risk_disclosure_version, native_opted_in_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
		 ON CONFLICT(user_id, machine_id) DO UPDATE SET
		   native_desktop_enabled = excluded.native_desktop_enabled,
		   native_maestro_enabled = excluded.native_maestro_enabled,
		   native_risk_disclosure_version = COALESCE(excluded.native_risk_disclosure_version, machine_policies.native_risk_disclosure_version),
		   native_opted_in_at = COALESCE(excluded.native_opted_in_at, machine_policies.native_opted_in_at),
		   updated_at = excluded.updated_at`,
	)
		.bind(userId, machineId, desktop ? 1 : 0, maestro ? 1 : 0, enabling ? NATIVE_RISK_DISCLOSURE_V1.version : null, enabling ? now : null, now)
		.run();
	return { ok: true, optIn: (await getNativeOptIn(env, userId, machineId))! };
}

/** The wire shape (snake_case, like the machine policy) — never anything but switches and the version. */
export function nativeOptInWire(o: NativeOptIn) {
	return {
		machine_id: o.machineId,
		native_desktop_enabled: o.desktop,
		native_maestro_enabled: o.maestro,
		native_risk_disclosure_version: o.disclosureVersion,
		native_disclosure_current: o.disclosureCurrent,
		native_opted_in_at: o.optedInAt,
		current_disclosure: NATIVE_RISK_DISCLOSURE_V1,
	};
}
