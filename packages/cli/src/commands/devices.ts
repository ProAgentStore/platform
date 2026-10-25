/**
 * `pags devices` — the machines signed in to this account, how long each sign-in lasts, and withdrawing one (#1184).
 *
 *   pags devices                  list this account's machines: name, id, expiry, status
 *   pags devices revoke <id>      stop one machine's sign-in at once (it signs in again with `pags login --device`)
 *   pags devices lifetime [days]  show, or set, how long NEW machine sign-ins last: 30, 90 or 180 days
 */
import { Command } from "commander";
import { writeError, writeLine } from "../output.js";
import { expiryLine, expiryWarning } from "../session-expiry.js";
import { loadSession, requireSession } from "./login.js";
import { sessionExpiresAt } from "./login-device.js";
import { pagsApiBase } from "./runner/http.js";

export const LIFETIME_CHOICES = [30, 90, 180] as const;

export interface DeviceView {
	id: string;
	node: string | null;
	lifetimeDays: number;
	expiresAt: string;
	status: "active" | "expired" | "revoked";
}

/** The list as lines. Pure so the wording is asserted without a server. */
export function deviceLines(devices: readonly DeviceView[], lifetimeDays: number): string[] {
	if (!devices.length) return [`No machines are signed in by device login yet. New sign-ins last ${lifetimeDays} days (change with \`pags devices lifetime\`).`];
	return [
		`New machine sign-ins last ${lifetimeDays} days (\`pags devices lifetime 30|90|180\`).`,
		...devices.map((d) => `${d.status.padEnd(7)}  ${(d.node ?? "(unnamed)").padEnd(28)} ${d.id}  ${d.status === "revoked" ? "revoked" : `until ${d.expiresAt.slice(0, 10)}`} (${d.lifetimeDays}-day sign-in)`),
	];
}

export function parseLifetime(value: string | undefined): number | null {
	const n = Number(value);
	return (LIFETIME_CHOICES as readonly number[]).includes(n) ? n : null;
}

async function api<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
	const res = await fetch(`${pagsApiBase()}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	const data = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
	return data;
}

export const devicesCommand = new Command("devices").description("The machines signed in to your account, and how long their sign-ins last").action(async () => {
	const session = requireSession();
	const mine = sessionExpiresAt(session.token);
	writeLine(expiryLine(mine, Date.now()));
	const warn = expiryWarning(mine, Date.now());
	if (warn) writeLine(warn);
	try {
		const r = await api<{ credentials: DeviceView[]; lifetimeDays: number }>("GET", "/v1/auth/device/credentials", session.token);
		for (const line of deviceLines(r.credentials, r.lifetimeDays)) writeLine(line);
	} catch (e) {
		writeError(e instanceof Error ? e.message : String(e));
		process.exitCode = 1;
	}
});

devicesCommand
	.command("revoke <id>")
	.description("Stop one machine's sign-in at once")
	.action(async (id: string) => {
		const session = requireSession();
		try {
			await api("DELETE", `/v1/auth/device/credentials/${encodeURIComponent(id)}`, session.token);
			writeLine(`Revoked ${id}. That machine is signed out; sign it in again with \`pags login --device\`.`);
		} catch (e) {
			writeError(e instanceof Error ? e.message : String(e));
			process.exitCode = 1;
		}
	});

devicesCommand
	.command("lifetime [days]")
	.description("Show, or set, how long NEW machine sign-ins last (30, 90 or 180 days)")
	.action(async (days: string | undefined) => {
		const session = loadSession();
		if (!session) {
			writeError("Not logged in. Run: pags login");
			process.exitCode = 1;
			return;
		}
		try {
			if (days === undefined) {
				const r = await api<{ lifetimeDays: number }>("GET", "/v1/auth/device/credentials", session.token);
				writeLine(`New machine sign-ins last ${r.lifetimeDays} days. Choices: ${LIFETIME_CHOICES.join(", ")}.`);
				return;
			}
			const n = parseLifetime(days);
			if (n === null) throw new Error(`days must be one of ${LIFETIME_CHOICES.join(", ")}.`);
			const r = await api<{ lifetimeDays: number; appliesTo: string }>("PUT", "/v1/auth/device/lifetime", session.token, { days: n });
			writeLine(`New machine sign-ins now last ${r.lifetimeDays} days — ${r.appliesTo}.`);
		} catch (e) {
			writeError(e instanceof Error ? e.message : String(e));
			process.exitCode = 1;
		}
	});
