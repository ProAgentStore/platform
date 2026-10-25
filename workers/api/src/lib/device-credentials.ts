import type { Env } from "../types.js";

/**
 * Per-machine, revocable runner sign-ins of a chosen lifetime (#1184).
 *
 * A device sign-in (#1157) is a session like any other — a signed token — so by itself nothing can withdraw it. Each approved
 * device gets a row here and its session carries the row's id (`did`); `requireUser` refuses a session whose row is revoked,
 * expired or missing. Browser sessions have no `did` and are never looked up, so this adds no read to them. The owner chooses
 * how long NEW credentials last: 30, 90 or 180 days.
 */
export const RUNNER_SESSION_DAYS = [30, 90, 180] as const;
export type RunnerSessionDays = (typeof RUNNER_SESSION_DAYS)[number];
export const DEFAULT_RUNNER_SESSION_DAYS: RunnerSessionDays = 30;
export const DAY_SECONDS = 24 * 60 * 60;

export const isLifetimeDays = (v: unknown): v is RunnerSessionDays => RUNNER_SESSION_DAYS.includes(v as RunnerSessionDays);

export interface DeviceCredentialView {
	id: string;
	node: string | null;
	lifetimeDays: number;
	createdAt: string;
	expiresAt: string;
	lastRefreshedAt: string | null;
	revokedAt: string | null;
	/** active | expired | revoked — what the credential is right now. */
	status: "active" | "expired" | "revoked";
}

interface Row {
	id: string;
	user_id: string;
	node: string | null;
	lifetime_days: number;
	created_at: number;
	expires_at: number;
	last_refreshed_at: number | null;
	revoked_at: number | null;
}

const iso = (s: number | null) => (s === null ? null : new Date(s * 1000).toISOString());
const secs = (now: number) => Math.floor(now / 1000);

function view(r: Row, now: number): DeviceCredentialView {
	return {
		id: r.id,
		node: r.node,
		lifetimeDays: r.lifetime_days,
		createdAt: iso(r.created_at) as string,
		expiresAt: iso(r.expires_at) as string,
		lastRefreshedAt: iso(r.last_refreshed_at),
		revokedAt: iso(r.revoked_at),
		status: r.revoked_at !== null ? "revoked" : r.expires_at <= secs(now) ? "expired" : "active",
	};
}

/** The owner's default for new device credentials. */
export async function getAccountLifetime(env: Pick<Env, "DB">, userId: string): Promise<RunnerSessionDays> {
	const row = await env.DB.prepare("SELECT runner_session_days FROM users WHERE id = ?1").bind(userId).first<{ runner_session_days: number | null }>();
	return isLifetimeDays(row?.runner_session_days) ? row.runner_session_days : DEFAULT_RUNNER_SESSION_DAYS;
}

export async function setAccountLifetime(env: Pick<Env, "DB">, userId: string, days: RunnerSessionDays): Promise<void> {
	await env.DB.prepare("UPDATE users SET runner_session_days = ?1 WHERE id = ?2").bind(days, userId).run();
}

/** A new credential for an approved machine. */
export async function createDeviceCredential(env: Pick<Env, "DB">, userId: string, node: string | null, days: RunnerSessionDays, now = Date.now()): Promise<{ id: string; expiresAt: number }> {
	const id = `dev_${crypto.randomUUID().replace(/-/g, "")}`;
	const expiresAt = secs(now) + days * DAY_SECONDS;
	await env.DB.prepare("INSERT INTO device_credentials (id, user_id, node, lifetime_days, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
		.bind(id, userId, node, days, secs(now), expiresAt)
		.run();
	return { id, expiresAt };
}

/**
 * Whether a session carrying this `did` must be refused: its credential is revoked, expired or unknown (fail closed — a
 * session naming a credential that does not exist is not one we issued). A database error answers "not revoked", like the
 * suspension gate: a blip must not sign every runner out, and the signed expiry still bounds the session.
 */
export async function deviceCredentialRefused(env: Pick<Env, "DB">, did: string, userId: string, now = Date.now()): Promise<boolean> {
	try {
		const row = await env.DB.prepare("SELECT user_id, expires_at, revoked_at FROM device_credentials WHERE id = ?1").bind(did).first<Pick<Row, "user_id" | "expires_at" | "revoked_at">>();
		return !row || row.user_id !== userId || row.revoked_at !== null || row.expires_at <= secs(now);
	} catch {
		return false;
	}
}

/** The owner's machines, newest first: active, expired and revoked ones for the last 90 days. */
export async function listDeviceCredentials(env: Pick<Env, "DB">, userId: string, now = Date.now()): Promise<DeviceCredentialView[]> {
	const { results } = await env.DB.prepare("SELECT * FROM device_credentials WHERE user_id = ?1 AND (revoked_at IS NULL OR revoked_at > ?2) ORDER BY created_at DESC LIMIT 100")
		.bind(userId, secs(now) - 90 * DAY_SECONDS)
		.all<Row>();
	return (results ?? []).map((r) => view(r, now));
}

/** Revoke one of the owner's credentials. False when it is not theirs or is already revoked. */
export async function revokeDeviceCredential(env: Pick<Env, "DB">, userId: string, id: string, now = Date.now()): Promise<boolean> {
	const res = await env.DB.prepare("UPDATE device_credentials SET revoked_at = ?1 WHERE id = ?2 AND user_id = ?3 AND revoked_at IS NULL").bind(secs(now), id, userId).run();
	return (res.meta?.changes ?? 0) > 0;
}

/** A refresh of a device session: the same credential, a new expiry of its own length. Null when it is revoked, expired or not theirs. */
export async function renewDeviceCredential(env: Pick<Env, "DB">, userId: string, did: string, now = Date.now()): Promise<{ expiresAt: number; lifetimeDays: number } | null> {
	const row = await env.DB.prepare("SELECT lifetime_days FROM device_credentials WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL AND expires_at > ?3").bind(did, userId, secs(now)).first<{ lifetime_days: number }>();
	if (!row) return null;
	const expiresAt = secs(now) + row.lifetime_days * DAY_SECONDS;
	const res = await env.DB.prepare("UPDATE device_credentials SET expires_at = ?1, last_refreshed_at = ?2 WHERE id = ?3 AND revoked_at IS NULL").bind(expiresAt, secs(now), did).run();
	return (res.meta?.changes ?? 0) > 0 ? { expiresAt, lifetimeDays: row.lifetime_days } : null;
}
