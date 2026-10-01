// Where a re-auth relay's progress is recorded, and how a parked run learns it finished (#881).
//
// One key in the instance config, `engineReauth`, patched with `json_set` like every other key
// (instance-config.ts, #231). It is the handshake between two things that never meet: the relay
// routes, driven by the owner from any device, and a Pilot run parked on `needs_reauth` inside a
// Workflow. The run polls {@link reauthCompletedSince}; the relay writes `succeeded` with the instant.
//
// No migration: the state is one small record per instance, overwritten by the next relay, and its
// only reader is the run parked on it — a table would be history nobody reads.

import { patchInstanceConfig } from "./instance-config.js";
import type { ReauthMethod } from "./engine-reauth.js";
import type { CodingClientType } from "./coding-types.js";
import type { Env } from "../types.js";

export const REAUTH_CONFIG_KEY = "engineReauth";

export type ReauthStatus = "pending" | "succeeded" | "failed" | "cancelled";

export interface EngineReauthState {
	clientType: CodingClientType;
	method: ReauthMethod;
	/** The runner tmux session the login CLI runs in. */
	session: string;
	/** The runner node the relay was started on — a status call must drive the SAME machine. */
	runnerNode: string | null;
	status: ReauthStatus;
	/** Epoch ms. */
	startedAt: number;
	/** Epoch ms, when the status became terminal. */
	completedAt: number | null;
	/**
	 * Who started the login (#890). `relay`: `coding_engine_reauth`, which owns its tmux session and
	 * closes it when the login ends. `observed`: someone typed it into their own tmux session through
	 * the tmux connector. The platform only watches that session and never closes it.
	 */
	origin: "relay" | "observed";
	/** The one-time code the flow showed when it was recorded, if any. Used to tell a restarted flow from the same one. */
	deviceCode: string | null;
	/** Epoch ms when the "about to expire" warning went out (#890). Set once, so it goes out once. */
	expiryWarnedAt: number | null;
}

const STATUSES: readonly ReauthStatus[] = ["pending", "succeeded", "failed", "cancelled"];

/** Parse the stored record, field by field — a malformed blob reads as "no relay", never a throw. */
export function parseReauthState(raw: unknown): EngineReauthState | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.clientType !== "string" || typeof r.method !== "string" || typeof r.session !== "string") return null;
	if (!STATUSES.includes(r.status as ReauthStatus) || typeof r.startedAt !== "number") return null;
	return {
		clientType: r.clientType as CodingClientType,
		method: r.method as ReauthMethod,
		session: r.session,
		runnerNode: typeof r.runnerNode === "string" ? r.runnerNode : null,
		status: r.status as ReauthStatus,
		startedAt: r.startedAt,
		completedAt: typeof r.completedAt === "number" ? r.completedAt : null,
		// Records written before #890 carry none of these: they were all relay-started, never warned.
		origin: r.origin === "observed" ? "observed" : "relay",
		deviceCode: typeof r.deviceCode === "string" ? r.deviceCode : null,
		expiryWarnedAt: typeof r.expiryWarnedAt === "number" ? r.expiryWarnedAt : null,
	};
}

export async function readReauthState(env: Env, instanceId: string, userId: string): Promise<EngineReauthState | null> {
	const row = await env.DB.prepare(
		"SELECT json_extract(CASE WHEN config IS NULL OR config = '' OR NOT json_valid(config) THEN '{}' ELSE config END, '$.engineReauth') AS state FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, userId)
		.first<{ state: string | null }>();
	if (!row?.state) return null;
	try {
		return parseReauthState(JSON.parse(row.state));
	} catch {
		return null;
	}
}

export async function writeReauthState(env: Env, instanceId: string, userId: string, state: EngineReauthState): Promise<void> {
	await patchInstanceConfig(env, instanceId, userId, REAUTH_CONFIG_KEY, state);
}

/**
 * Mark the expiry warning as sent, only if it has not been sent for THIS flow (#890). The condition
 * is in SQL, so two overlapping cron ticks cannot both win: `true` means this caller claimed it and
 * must send the warning, `false` means it was already sent or a newer flow replaced this one.
 */
export async function claimExpiryWarning(env: Env, instanceId: string, userId: string, startedAt: number, now: number): Promise<boolean> {
	const res = await env.DB.prepare(
		`UPDATE agent_instances
		    SET config = json_set(config, '$.engineReauth.expiryWarnedAt', ?1)
		  WHERE id = ?2 AND user_id = ?3 AND json_valid(config)
		    AND json_extract(config, '$.engineReauth.status') = 'pending'
		    AND json_extract(config, '$.engineReauth.startedAt') = ?4
		    AND json_extract(config, '$.engineReauth.expiryWarnedAt') IS NULL`,
	)
		.bind(now, instanceId, userId, startedAt)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

/**
 * Close out a pending flow the sweep saw end on its pane (#890), only if it is still THIS flow. A
 * newer sign-in started in between is left alone.
 */
export async function finishReauthIfCurrent(env: Env, instanceId: string, userId: string, startedAt: number, status: "succeeded" | "failed", now: number): Promise<boolean> {
	const res = await env.DB.prepare(
		`UPDATE agent_instances
		    SET config = json_set(config, '$.engineReauth.status', ?1, '$.engineReauth.completedAt', ?2)
		  WHERE id = ?3 AND user_id = ?4 AND json_valid(config)
		    AND json_extract(config, '$.engineReauth.status') = 'pending'
		    AND json_extract(config, '$.engineReauth.startedAt') = ?5`,
	)
		.bind(status, now, instanceId, userId, startedAt)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

/** Did a relay sign an engine in at or after `since`? What a run parked on sign-in polls. */
export function reauthSucceededSince(state: EngineReauthState | null, since: number): boolean {
	return !!state && state.status === "succeeded" && (state.completedAt ?? 0) >= since;
}

export async function reauthCompletedSince(env: Env, instanceId: string, userId: string, since: number): Promise<boolean> {
	return reauthSucceededSince(await readReauthState(env, instanceId, userId).catch(() => null), since);
}

// ── Is the instance blocked on sign-in right now? ───────────────────────────

/** The newest loop run on an instance, reduced to what the sign-in question needs. */
export interface LatestRunRow {
	run_id: string;
	session_id: string | null;
	status: string;
	stop_reason: string | null;
	waiting_reason: string | null;
	started_at: number;
	finished_at: number | null;
}

export interface SignInBlock {
	runId: string;
	sessionId: string | null;
	/** `parked` — the run is waiting for the sign-in and resumes on its own; `stopped` — it gave up. */
	state: "parked" | "stopped";
	/** ms epoch the block began to count from. */
	since: number;
}

/** How long a run that stopped on sign-in keeps the instance flagged. Past this it is history. */
export const SIGN_IN_BLOCK_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The run evidence that the engine is not signed in, unless a relay has signed it in since (#881).
 * Pure — `coding_diagnostics` reads it, and the rule is the whole point, so it is testable alone.
 */
export function signInBlockFrom(row: LatestRunRow | null, relay: EngineReauthState | null, now: number): SignInBlock | null {
	if (!row) return null;
	let block: SignInBlock | null = null;
	if (row.status === "running" && row.waiting_reason === "engine_auth") {
		block = { runId: row.run_id, sessionId: row.session_id, state: "parked", since: row.started_at };
	} else if (row.stop_reason === "engine_auth" && row.finished_at && now - row.finished_at <= SIGN_IN_BLOCK_WINDOW_MS) {
		block = { runId: row.run_id, sessionId: row.session_id, state: "stopped", since: row.finished_at };
	}
	return block && !reauthSucceededSince(relay, block.since) ? block : null;
}

export async function latestRunRow(env: Env, instanceId: string, userId: string): Promise<LatestRunRow | null> {
	return await env.DB.prepare(
		"SELECT run_id, session_id, status, stop_reason, waiting_reason, started_at, finished_at FROM agent_loop_runs WHERE instance_id = ?1 AND user_id = ?2 ORDER BY started_at DESC LIMIT 1",
	)
		.bind(instanceId, userId)
		.first<LatestRunRow>();
}
