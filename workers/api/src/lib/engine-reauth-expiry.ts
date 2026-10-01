// Warn before an unattended device-code sign-in expires (#890).
//
// ── The failure
//
// `codex login --device-auth` shows a one-time code that is good for 15 minutes. When nobody enters
// it, the CLI prints "device auth timed out after 15 minutes" into a tmux pane nobody is watching.
// The missing login surfaced much later, as a coding run crash-looping on HTTP 401s. The #881 relay
// records the flow (`engineReauth`), but that record only moves when someone asks for its status,
// and in this failure nobody was asking.
//
// ── What this adds
//
//   * `runReauthExpiryWatch`, a per-minute cron sweep. When a pending flow has
//     {@link REAUTH_EXPIRY_WARN_BEFORE_MS} left, it reads the login pane. Only if the pane still
//     shows the device code (the same reading `coding_engine_reauth` uses) does it claim the
//     one-shot marker and send an alert with the URL, the code and the time left. That is a warning
//     while the code still works, not a failure report afterwards. A runner that cannot be read
//     sends nothing: the platform cannot tell the flow is still waiting, and a false "your sign-in
//     is expiring" costs the signal its trust. A pane that shows the login finished, failed or gone
//     closes the record out instead, so the flag below never reports a flow that has ended.
//   * `reauthExpiryView`, the same fact as a flag for `coding_diagnostics` and `coding_session_capture`.
//     It is computed from the stored record, so a caller can see it without a pane read.
//   * `observeDeviceAuth`, for a flow started by hand in the owner's own tmux session through the
//     tmux connector. That flow never went through the relay, so it had no record at all. When a
//     tmux tool's pane shows a Codex device code, the flow is recorded as `observed`, and the sweep
//     then treats it like a relay flow. The platform never closes that session.
//
// ── What it does not cover
//
// Only methods with a KNOWN code lifetime are watched ({@link REAUTH_CODE_TTL_MS}). Claude's
// paste-code and setup-token flows publish no lifetime here, and a guessed one would warn at the
// wrong time. An `observed` flow is timed from when the platform first saw the code, which can be
// later than when it was printed, so its warning can come late but never early.

import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS } from "./runner-client.js";
import { readReauthPane, type ReauthMethod } from "./engine-reauth.js";
import { claimExpiryWarning, finishReauthIfCurrent, parseReauthState, readReauthState, writeReauthState, type EngineReauthState } from "./engine-reauth-store.js";
import { notifyUser } from "../routes/push.js";
import type { Env } from "../types.js";

/** How long each method's one-time code stays usable. Only these methods are watched. */
export const REAUTH_CODE_TTL_MS: Partial<Record<ReauthMethod, number>> = {
	// Codex prints the code as expiring in 15 minutes, and times out at 15 ("device auth timed out after 15 minutes").
	"codex-device-auth": 15 * 60_000,
};

/** Warn this long before expiry: 5 minutes left, at the 10-minute mark of a 15-minute code. */
export const REAUTH_EXPIRY_WARN_BEFORE_MS = 5 * 60_000;

/** The most flows one sweep looks at. A tick that has more leaves the rest for the next one. */
const SWEEP_LIMIT = 50;

export interface ReauthExpiryView {
	clientType: EngineReauthState["clientType"];
	method: ReauthMethod;
	origin: EngineReauthState["origin"];
	/** The tmux session the login runs in. */
	session: string;
	startedAt: string;
	expiresAt: string;
	/** Whole seconds until the code expires. 0 once it has. */
	expiresInSeconds: number;
	/** 5 minutes or less left, and not yet expired: sign in now. */
	expiringSoon: boolean;
	/** Past its lifetime: the code no longer works, and a new sign-in has to be started. */
	expired: boolean;
	/** When the proactive warning went out, if it has. */
	warnedAt: string | null;
}

/** When this flow's code expires, or null when the flow is not pending or its lifetime is not known. */
export function reauthExpiresAt(state: EngineReauthState | null): number | null {
	if (state?.status !== "pending") return null;
	const ttl = REAUTH_CODE_TTL_MS[state.method];
	return ttl ? state.startedAt + ttl : null;
}

/** The flag `coding_diagnostics` and `coding_session_capture` carry. Null when there is nothing to watch. */
export function reauthExpiryView(state: EngineReauthState | null, now: number): ReauthExpiryView | null {
	const expiresAt = reauthExpiresAt(state);
	if (!state || expiresAt === null) return null;
	const left = expiresAt - now;
	return {
		clientType: state.clientType,
		method: state.method,
		origin: state.origin,
		session: state.session,
		startedAt: new Date(state.startedAt).toISOString(),
		expiresAt: new Date(expiresAt).toISOString(),
		expiresInSeconds: Math.max(0, Math.floor(left / 1000)),
		expiringSoon: left > 0 && left <= REAUTH_EXPIRY_WARN_BEFORE_MS,
		expired: left <= 0,
		warnedAt: state.expiryWarnedAt ? new Date(state.expiryWarnedAt).toISOString() : null,
	};
}

/** Is the warning due for this flow now? Pending, lifetime known, inside the window, not yet sent. */
export function expiryWarningDue(state: EngineReauthState | null, now: number): boolean {
	const view = reauthExpiryView(state, now);
	return !!view && view.expiringSoon && !state?.expiryWarnedAt;
}

/** What the warning says. Pure, so every word can be asserted. */
export function expiryWarningText(input: { clientType: string; url: string | null; deviceCode: string | null; expiresAt: number; now: number; machine: string | null }): { title: string; body: string } {
	const minutes = Math.max(1, Math.round((input.expiresAt - input.now) / 60_000));
	const where = input.machine ? ` on machine "${input.machine}"` : "";
	const act =
		input.url && input.deviceCode
			? `Open ${input.url} on any device, sign in with your subscription account and enter the code ${input.deviceCode}.`
			: "Finish the sign-in with coding_engine_reauth (action \"status\" shows the link and code).";
	return {
		title: `⏳ Coding engine sign-in expires in ~${minutes} min`,
		body: `The ${input.clientType} sign-in started${where} is still waiting and its one-time code expires at ${new Date(input.expiresAt).toISOString().slice(11, 16)} UTC. ${act} If it expires, start a new sign-in with coding_engine_reauth.`,
	};
}

interface Candidate {
	id: string;
	user_id: string;
	state: string | null;
}

/** How long past expiry the sweep keeps reading a flow's pane to learn how it ended. */
const FOLLOW_AFTER_EXPIRY_MS = 10 * 60_000;

export type SweepOutcome = "warned" | "waiting" | "finished" | "unreadable" | "already-warned";

/**
 * One pending flow, read on its pane. Exported for tests.
 *
 *   - The login finished or failed, or its terminal is gone: the record is closed out, so the flag
 *     stops reporting a sign-in that is no longer waiting. A run parked on sign-in also sees a
 *     success this way, even if nobody polled the relay.
 *   - The code is still on screen and the warning is due: claim the one-shot marker, then warn.
 *   - The runner cannot be read: nothing. The platform does not know the flow is still waiting.
 */
export async function sweepReauthFlow(env: Env, instanceId: string, userId: string, state: EngineReauthState, now: number): Promise<SweepOutcome> {
	const conn = await getBoundRunnerConn(env, instanceId, userId).catch(() => null);
	if (!conn) return "unreadable";
	let pane: string | null;
	try {
		const r = await callRunner<{ pane?: string }>(conn, "/tmux/capture", { session: state.session, lines: 400 }, { timeoutMs: READ_TIMEOUT_MS });
		pane = String(r?.pane ?? "");
	} catch (e) {
		// A 404 is the session being gone, the same reading the relay's own capture makes.
		if (e instanceof Error && e.message.includes("→ 404")) pane = null;
		else return "unreadable";
	}
	const reading = pane === null ? null : readReauthPane(pane, state.method);
	if (!reading || reading.state === "succeeded" || reading.state === "failed") {
		await finishReauthIfCurrent(env, instanceId, userId, state.startedAt, reading?.state === "succeeded" ? "succeeded" : "failed", now);
		return "finished";
	}
	// The same test the relay's status uses: the code is on screen and nothing says the login ended.
	if (reading.state !== "device_code" || !expiryWarningDue(state, now)) return "waiting";
	if (!(await claimExpiryWarning(env, instanceId, userId, state.startedAt, now))) return "already-warned";
	const expiresAt = reauthExpiresAt(state) ?? now;
	const text = expiryWarningText({ clientType: state.clientType, url: reading.url, deviceCode: reading.deviceCode, expiresAt, now, machine: state.runnerNode });
	await notifyUser(env, userId, "coding", text.title, text.body, undefined, {
		key: `coding-reauth-expiring:${instanceId}:${state.startedAt}`,
		instanceId,
		kind: "alert",
	}).catch(() => undefined);
	return "warned";
}

/** The cron sweep. Never throws: a failure here must not reach the other scheduled work. */
export async function runReauthExpiryWatch(env: Env, now: number = Date.now()): Promise<void> {
	try {
		// Only methods with a known lifetime: from the moment one enters its warning window until a
		// while after it expires, which is long enough to see how it ended.
		const ttls = Object.values(REAUTH_CODE_TTL_MS).filter((t): t is number => typeof t === "number");
		const newest = now - (Math.min(...ttls) - REAUTH_EXPIRY_WARN_BEFORE_MS);
		const oldest = now - Math.max(...ttls) - FOLLOW_AFTER_EXPIRY_MS;
		const { results } = await env.DB.prepare(
			`SELECT id, user_id, json_extract(config, '$.engineReauth') AS state FROM agent_instances
			  WHERE json_valid(config)
			    AND json_extract(config, '$.engineReauth.status') = 'pending'
			    AND json_extract(config, '$.engineReauth.startedAt') BETWEEN ?1 AND ?2
			  LIMIT ?3`,
		)
			.bind(oldest, newest, SWEEP_LIMIT)
			.all<Candidate>();
		for (const row of results ?? []) {
			let state: EngineReauthState | null = null;
			try {
				state = parseReauthState(row.state ? JSON.parse(row.state) : null);
			} catch {
				state = null;
			}
			if (!state || reauthExpiresAt(state) === null) continue;
			await sweepReauthFlow(env, row.id, row.user_id, state, now).catch(() => undefined);
		}
	} catch (e) {
		console.error("reauth-expiry-watch", e instanceof Error ? e.message : String(e));
	}
}

/**
 * Is this pane a Codex device-code sign-in waiting for its code? Narrow on purpose: it takes the
 * relay's reading (a code AND an https URL on a known sign-in host) plus the word "device". An
 * ordinary shell, build or coding session does not print all of those at once.
 */
export function paneShowsDeviceAuth(pane: string): { url: string; deviceCode: string } | null {
	const reading = readReauthPane(pane, "codex-device-auth");
	if (reading.state !== "device_code" || !reading.url || !reading.deviceCode) return null;
	if (!/device/i.test(pane)) return null;
	return { url: reading.url, deviceCode: reading.deviceCode };
}

/**
 * Record a device-code sign-in the owner started in their own tmux session (#890), so the sweep
 * watches it. It leaves alone the same flow already on record, and a relay flow that is still live.
 */
export async function observeDeviceAuth(
	env: Env,
	input: { instanceId?: string | null; userId?: string | null; runnerNode: string | null; session: string; pane: string; now?: number },
): Promise<boolean> {
	if (!input.instanceId || !input.userId) return false;
	const seen = paneShowsDeviceAuth(input.pane);
	if (!seen) return false;
	const now = input.now ?? Date.now();
	const existing = await readReauthState(env, input.instanceId, input.userId).catch(() => null);
	if (existing?.status === "pending") {
		const expiresAt = reauthExpiresAt(existing);
		const live = expiresAt === null ? now - existing.startedAt < 60 * 60_000 : now < expiresAt;
		// The same flow, seen again: keep its original start, which is what the warning is timed from.
		if (existing.session === input.session && (existing.deviceCode === seen.deviceCode || existing.deviceCode === null) && live) return false;
		// A different live relay flow is not overwritten by one noticed in passing.
		if (existing.origin === "relay" && existing.session !== input.session && live) return false;
	}
	await writeReauthState(env, input.instanceId, input.userId, {
		clientType: "codex",
		method: "codex-device-auth",
		session: input.session,
		runnerNode: input.runnerNode,
		status: "pending",
		startedAt: now,
		completedAt: null,
		origin: "observed",
		deviceCode: seen.deviceCode,
		expiryWarnedAt: null,
	});
	return true;
}
