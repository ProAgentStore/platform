/**
 * Device sign-in for `pags login --device` (#1157) — RFC 8628 device authorization, the PAGS way.
 *
 * On 18 Oct 2026 the Dell runner's session had expired, `pags login` could only open a browser on the machine
 * itself, and recovery needed someone at the keyboard. Now a machine with no browser (SSH, headless) asks for a
 * code, shows it, and polls; the owner approves it from any device where they are signed in to the console.
 *
 *   start   → a device code (the machine's secret for this exchange; only its hash is stored) and a short user
 *             code the owner types or follows a link with;
 *   approve → the signed-in owner binds the request to their account (or denies it), after seeing which machine
 *             asked, from where and when — the defence against a code someone else started and sent them;
 *   poll    → `authorization_pending` / `slow_down` / `access_denied` / `expired_token`, or — exactly once —
 *             the account that approved it, for the route to mint a session for.
 */
import type { Env } from "../types.js";
import type { DeviceRequestView } from "./device-auth-view.js";

export type { DeviceDecisionResponse, DeviceRequestResponse, DeviceRequestView } from "./device-auth-view.js";

/** How long a request waits for the owner. */
export const DEVICE_CODE_TTL_SECONDS = 10 * 60;
/** The poll interval the machine is told to keep; faster polls are answered `slow_down` (RFC 8628 §3.5). */
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
/** RFC 8628 §6.1: consonants only, so a code cannot spell a word and is easy to read out. 20^8 codes. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export type DevicePoll =
	| { kind: "approved"; userId: string; node: string | null; lifetimeDays: number | null; scope: "runner" | null }
	| { kind: "authorization_pending" | "slow_down" | "access_denied" | "expired_token" };

async function sha256hex(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `XXXX-XXXX` from {@link USER_CODE_ALPHABET}. */
export function generateUserCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
	// 240 is the largest multiple of 20 below 256: bytes from 240 up are dropped so every letter is equally likely.
	const out: string[] = [];
	while (out.length < 8) {
		for (const b of random(16)) if (b < 240 && out.length < 8) out.push(USER_CODE_ALPHABET[b % 20]);
	}
	return `${out.slice(0, 4).join("")}-${out.slice(4).join("")}`;
}

/** What the owner typed, as stored: upper-cased, separators and spaces dropped, re-hyphenated. Null when it cannot be one. */
export function normalizeUserCode(input: unknown): string | null {
	if (typeof input !== "string") return null;
	const letters = input.toUpperCase().replace(/[^A-Z]/g, "");
	if (letters.length !== 8 || [...letters].some((ch) => !USER_CODE_ALPHABET.includes(ch))) return null;
	return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Open a request. Returns the device code in plaintext — the only time it exists outside the machine. */
export async function startDeviceAuthorization(env: Pick<Env, "DB">, client: { node?: unknown; ip?: unknown; country?: unknown; scope?: unknown }, now = Date.now()): Promise<{ deviceCode: string; userCode: string; expiresIn: number; interval: number }> {
	const at = Math.floor(now / 1000);
	await env.DB.prepare("DELETE FROM device_authorizations WHERE expires_at < ?1").bind(at - 24 * 3600).run().catch(() => undefined);
	const deviceCode = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
	const hash = await sha256hex(deviceCode);
	// A user-code collision with a live request is astronomically rare; the UNIQUE constraint makes it a retry, not a mix-up.
	for (let attempt = 0; ; attempt++) {
		const userCode = generateUserCode();
		try {
			await env.DB.prepare(
				`INSERT INTO device_authorizations (device_code_hash, user_code, status, client_node, client_ip, client_country, created_at, expires_at, requested_scope)
				 VALUES (?1, ?2, 'pending', ?3, ?4, ?5, ?6, ?7, ?8)`,
			).bind(hash, userCode, text(client.node, 120), text(client.ip, 64), text(client.country, 8), at, at + DEVICE_CODE_TTL_SECONDS, client.scope === "runner" ? "runner" : null).run();
			return { deviceCode, userCode, expiresIn: DEVICE_CODE_TTL_SECONDS, interval: DEVICE_POLL_INTERVAL_SECONDS };
		} catch (e) {
			if (attempt >= 3) throw e;
		}
	}
}

interface Row {
	user_code: string;
	status: DeviceRequestView["status"];
	user_id: string | null;
	client_node: string | null;
	client_ip: string | null;
	client_country: string | null;
	requested_scope: string | null;
	created_at: number;
	expires_at: number;
	last_polled_at: number | null;
}

/** The request behind a user code, for the approval page. Null when there is none — or it has expired. */
export async function getDeviceRequest(env: Pick<Env, "DB">, userCode: string, now = Date.now()): Promise<DeviceRequestView | null> {
	const row = await env.DB.prepare("SELECT * FROM device_authorizations WHERE user_code = ?1").bind(userCode).first<Row>();
	if (!row || row.expires_at <= Math.floor(now / 1000)) return null;
	return {
		userCode: row.user_code,
		status: row.status,
		node: row.client_node,
		ip: row.client_ip,
		country: row.client_country,
		requestedScope: row.requested_scope === "runner" ? "runner" : null,
		createdAt: new Date(row.created_at * 1000).toISOString(),
		expiresAt: new Date(row.expires_at * 1000).toISOString(),
	};
}

/** The owner's decision. Only a pending, unexpired request can be decided, once. */
export async function decideDeviceRequest(env: Pick<Env, "DB">, userId: string, userCode: string, approve: boolean, now = Date.now(), lifetimeDays: number | null = null, scope: "runner" | null = null): Promise<"ok" | "gone"> {
	const at = Math.floor(now / 1000);
	const res = await env.DB.prepare(
		"UPDATE device_authorizations SET status = ?1, user_id = ?2, decided_at = ?3, lifetime_days = ?5, scope = ?6 WHERE user_code = ?4 AND status = 'pending' AND expires_at > ?3",
	).bind(approve ? "approved" : "denied", approve ? userId : null, at, userCode, approve ? lifetimeDays : null, approve ? scope : null).run();
	return (res.meta?.changes ?? 0) > 0 ? "ok" : "gone";
}

/**
 * The machine's poll. An approved request is CONSUMED atomically by the poll that sees it, so one approval yields
 * one session however many polls race. A poll faster than the interval is told `slow_down` and changes nothing else.
 */
export async function pollDeviceAuthorization(env: Pick<Env, "DB">, deviceCode: unknown, now = Date.now()): Promise<DevicePoll> {
	if (typeof deviceCode !== "string" || !/^[0-9a-f]{64}$/.test(deviceCode)) return { kind: "expired_token" };
	const at = Math.floor(now / 1000);
	const hash = await sha256hex(deviceCode);
	const row = await env.DB.prepare("SELECT status, expires_at, last_polled_at FROM device_authorizations WHERE device_code_hash = ?1").bind(hash).first<Pick<Row, "status" | "expires_at" | "last_polled_at">>();
	if (!row || row.status === "consumed") return { kind: "expired_token" };
	if (row.status === "denied") return { kind: "access_denied" };
	if (row.expires_at <= at) return { kind: "expired_token" };
	if (row.status === "approved") {
		const taken = await env.DB.prepare("UPDATE device_authorizations SET status = 'consumed' WHERE device_code_hash = ?1 AND status = 'approved' RETURNING user_id, client_node, lifetime_days, scope")
			.bind(hash)
			.first<{ user_id: string | null; client_node: string | null; lifetime_days: number | null; scope: string | null }>();
		return taken?.user_id ? { kind: "approved", userId: taken.user_id, node: taken.client_node, lifetimeDays: taken.lifetime_days, scope: taken.scope === "runner" ? "runner" : null } : { kind: "expired_token" };
	}
	await env.DB.prepare("UPDATE device_authorizations SET last_polled_at = ?1 WHERE device_code_hash = ?2").bind(at, hash).run();
	// A second inside the interval is slow; clock granularity (1s) leaves a margin of one second.
	return row.last_polled_at !== null && at - row.last_polled_at < DEVICE_POLL_INTERVAL_SECONDS - 1 ? { kind: "slow_down" } : { kind: "authorization_pending" };
}
