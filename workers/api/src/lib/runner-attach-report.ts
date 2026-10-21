/**
 * Why a runner attach did not land, measured — and a record of every attempt (#1114).
 *
 * `set_instance_runner_node` and `force_runner_attach` answered `{attached:false, unconfirmed:true}`
 * with "not yet confirmed" for a PAUSED agent pinned to an online machine: the server never looked
 * at the instance's status (a runner never attaches a paused one — `isEligible`, CLI
 * `runner/membership.ts`), and the attach's own reason arrived after the route's 15s confirmation
 * window had already answered blind. Nothing was written anywhere, so the failure was invisible
 * afterwards too: no activity entry, no error-log row.
 *
 * This module holds the three things that fix it:
 *
 *   - {@link AttachProgress}: the phase the attach has REACHED, written by `runner-repin.ts` as it
 *     goes, so a window that expires answers from what was observed ("the attach request was sent
 *     to X 15 s ago and not answered") instead of "not yet confirmed".
 *   - {@link staleRegistration}: a machine whose registration is old (not seen for a week, or a CLI
 *     too old to be asked) is FLAGGED. Never pruned — #393 decided a timer cannot tell a closed
 *     laptop from a dead one; `forget_runner_node` stays the only removal.
 *   - {@link recordAttach}: each attempt and outcome in the instance's activity log, and the real
 *     failures in the error log. Expected states (paused, already attached) are activity only.
 *
 * Load is CONTEXT, never a cause: a timeout is reported as a timeout, with the machine's last
 * heartbeat sample beside it so a reader can weigh it — a busy machine and a dead socket look
 * alike from here, and the sample cannot tell them apart.
 */
import { agentCapabilities } from "./agent-capabilities.js";
import { logError } from "./error-log.js";
import { compareCliVersions, stampMs } from "./machine-identity.js";
import { RUNNER_CONTROL_MIN_CLI } from "./runner-features.js";
import { latestResourceSample, resourcesView } from "./runner-resources.js";
import { normalizeRunnerNode } from "./runtime-nodes.js";
import type { Env } from "../types.js";

/** Why an attach did not land. Absent on an attach that did. */
export type AttachCause =
	| "paused" // the instance is paused; no runner attaches a paused agent
	| "not_active" // the instance is canceled; no runner attaches it either
	| "no_runtime" // the agent declares no local runtime; `pags up` never holds a socket for it
	| "no_socket" // nothing on the machine holds a relay socket to ask, or the one it opened never appeared
	| "runner_timeout" // the runner was asked and did not answer in the time measured
	| "runner_unresponsive" // every socket on the machine is connected but answers nothing
	| "refused" // the runner answered and would not take it (pinned elsewhere, --instance, an error)
	| "stale_registration" // the machine's registration is old — see staleRegistration
	| "old_runner"; // the runner predates the attach command and did not attach on its own poll

/** How far an attach got. Written in order; the last value is where it stopped. */
export type AttachPhase = "started" | "evicting" | "no_carrier" | "sync_sent" | "sync_unanswered" | "waiting_open" | "refused" | "done";

export interface AttachProgress {
	phase: AttachPhase;
	/** Epoch ms the attach began. */
	startedAt: number;
	/** Epoch ms the attach request was sent to the machine's runner, and over whose socket. */
	syncSentAt?: number;
	carrier?: string;
	/** Epoch ms the runner answered the attach request. */
	answeredAt?: number;
}

export function newAttachProgress(now = Date.now()): AttachProgress {
	return { phase: "started", startedAt: now };
}

/** A registration not seen for this long is flagged stale. */
export const STALE_REGISTRATION_MS = 7 * 24 * 60 * 60 * 1000;

export interface StaleFlag {
	lastSeenAt: string | null;
	version: string | null;
	reason: string;
}

/**
 * Is the registration under these names stale? The freshest row decides: one recent heartbeat under
 * any of the machine's names means the machine is alive. Below {@link RUNNER_CONTROL_MIN_CLI} the
 * runner cannot be asked to attach at all. A flag only — nothing is removed or changed.
 */
export function staleRegistration(rows: ReadonlyArray<{ node: string; lastSeenAt: string | null; version?: string | null }>, names: readonly string[], now = Date.now()): StaleFlag | null {
	let best: { at: number; lastSeenAt: string | null; version: string | null } | null = null;
	for (const r of rows) {
		if (!names.includes(normalizeRunnerNode(r.node))) continue;
		const at = stampMs(r.lastSeenAt);
		if (!best || at > best.at) best = { at, lastSeenAt: r.lastSeenAt, version: r.version?.trim() || null };
	}
	if (!best) return null;
	const reasons: string[] = [];
	if (best.at > 0 && now - best.at > STALE_REGISTRATION_MS) reasons.push(`not seen for ${Math.floor((now - best.at) / 86_400_000)} days`);
	const cmp = best.version ? compareCliVersions(best.version, RUNNER_CONTROL_MIN_CLI) : null;
	if (cmp !== null && cmp < 0) reasons.push(`runner ${best.version} predates ${RUNNER_CONTROL_MIN_CLI}, the first that can be asked to attach`);
	return reasons.length ? { lastSeenAt: best.lastSeenAt, version: best.version, reason: reasons.join("; ") } : null;
}

/** This machine's registrations with their versions, for {@link staleRegistration}. */
export async function machineRegistrations(env: Pick<Env, "DB">, userId: string, names: readonly string[]): Promise<Array<{ node: string; lastSeenAt: string | null; version: string | null }>> {
	const list = names.filter(Boolean); // one machine's names: bounded by MAX_MACHINE_NAMES
	if (!list.length) return [];
	const marks = list.map((_, i) => `?${i + 2}`).join(", ");
	const { results } = await env.DB.prepare(`SELECT runner_node AS node, last_seen_at AS lastSeenAt, runner_version AS version FROM instance_runtime_nodes WHERE user_id = ?1 AND runner_node IN (${marks})`)
		.bind(userId, ...list)
		.all<{ node: string; lastSeenAt: string | null; version: string | null }>()
		.catch(() => ({ results: [] as Array<{ node: string; lastSeenAt: string | null; version: string | null }> }));
	return results ?? [];
}

/** The machine's last heartbeat, as context for a timeout — labelled so it is never read as the cause. */
export interface HeartbeatContext {
	/** null = the machine reports no load (Windows, #1258). */
	load1: number | null;
	load5: number | null;
	load15: number | null;
	cpus: number;
	memUsedPct: number;
	sampledAt: string;
	sampleAgeSec: number;
	note: string;
}

export async function heartbeatContext(env: Pick<Env, "DB">, userId: string, names: readonly string[], now = Date.now()): Promise<HeartbeatContext | null> {
	const view = resourcesView(await latestResourceSample(env, userId, names).catch(() => null), null);
	if (!view) return null;
	return {
		load1: view.load1,
		load5: view.load5,
		load15: view.load15,
		cpus: view.cpus,
		memUsedPct: view.memUsedPct,
		sampledAt: view.sampledAt,
		sampleAgeSec: Math.max(0, Math.round((now - Date.parse(view.sampledAt)) / 1000)),
		note: "The machine's last heartbeat sample, as context only — it is not the measured cause.",
	};
}

const secs = (ms: number) => Math.max(0, Math.round(ms / 1000));

/**
 * The answer for a confirmation window that expired, from what the attach had observed by then.
 * Every branch is a measurement of this attach — the phase it reached and how long it has waited.
 */
export function windowExpiredCause(progress: AttachProgress, node: string, now = Date.now()): { cause: AttachCause; detail: string } {
	switch (progress.phase) {
		case "sync_sent":
		case "sync_unanswered":
			return {
				cause: "runner_timeout",
				detail: `The runner on ${node} did not answer the attach request within ${secs(now - (progress.syncSentAt ?? progress.startedAt))}s${progress.carrier ? ` (asked over ${progress.carrier}'s socket)` : ""}. The request is still open; call instance_runner_node to see whether it attached.`,
			};
		case "waiting_open":
			return {
				cause: "no_socket",
				detail: `The runner on ${node} answered the attach request ${secs(now - (progress.answeredAt ?? progress.startedAt))}s ago, but this agent's socket has not opened there yet. Call instance_runner_node to see whether it attached.`,
			};
		case "no_carrier":
			return { cause: "no_socket", detail: `Nothing on ${node} holds a relay socket to ask, so the attach waits on that machine's own poll. Call instance_runner_node to confirm.` };
		case "refused":
			return { cause: "refused", detail: `The runner on ${node} refused the attach request.` };
		default:
			return {
				cause: "runner_timeout",
				detail: `The relay did not finish checking this agent's slot on ${node} within ${secs(now - progress.startedAt)}s, so no runner had been asked yet. Call instance_runner_node before retrying.`,
			};
	}
}

/** The causes that are a real failure (error log), not an expected state (activity only). */
const FAILURE_CAUSES: ReadonlySet<AttachCause> = new Set(["no_socket", "runner_timeout", "runner_unresponsive", "refused", "stale_registration", "old_runner"]);

export interface AttachRecord {
	instanceId: string;
	userId: string;
	node: string;
	via: "pin" | "force_attach";
	forced: boolean;
	/** `attached`, `not_attached`, or `unconfirmed` (a window answered before the attach settled). */
	outcome: "attached" | "not_attached" | "unconfirmed";
	cause?: AttachCause;
	detail?: string;
	durationMs: number;
	context?: Record<string, unknown>;
}

/** Activity entry for every attempt; error-log row for a real failure. Never throws. */
export async function recordAttach(env: Env, r: AttachRecord): Promise<void> {
	const data = { node: r.node, via: r.via, forced: r.forced, outcome: r.outcome, ...(r.cause ? { cause: r.cause } : {}), ...(r.detail ? { detail: r.detail } : {}), durationMs: r.durationMs };
	try {
		await env.AGENT.get(env.AGENT.idFromName(r.instanceId)).fetch(
			new Request("https://agent/activity/runner-attach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: r.userId, data }) }),
		);
	} catch {
		/* the record must never change what the caller is told */
	}
	if (r.outcome !== "attached" && r.cause && FAILURE_CAUSES.has(r.cause)) {
		await logError(env, {
			source: "runner.attach",
			level: "warn",
			userId: r.userId,
			message: `Runner attach on ${r.node} ${r.outcome === "unconfirmed" ? "unconfirmed" : "failed"} (${r.cause}): ${r.detail ?? ""}`.trim(),
			context: { instanceId: r.instanceId, ...data, ...(r.context ?? {}) },
		});
	}
}

/** The instance's lifecycle status, or null when it cannot be read. */
export const PAUSED_DETAIL = "Instance is paused — resume it (resume_instance) to attach. No runner attaches a paused agent; the pin and the paused status are unchanged.";
const NOT_ACTIVE_DETAIL = "Instance is canceled — no runner attaches a canceled agent, so nothing was asked. Subscribe to the agent again (subscribe_agent) to run it; the pin is unchanged.";
const NO_RUNTIME_DETAIL = "This agent runs in the cloud and declares no local runtime, so no `pags up` ever holds a socket for it — there is nothing to attach, and nothing was asked. The pin is saved but does not change where it runs.";

/**
 * Why no runner would attach this instance, whatever the machine does — or null when one can (#1114).
 *
 * This is the runner's own eligibility rule (`isEligible`, CLI `runner/membership.ts`), stated on
 * this side: an instance is attached only while `active` and only when its agent declares a local
 * `runtime`. The CLI also never receives a paused or canceled instance from `/my/instances`. The
 * route used to check `paused` alone, so a canceled instance or a cloud-only agent still sent the
 * machine an attach it was bound to ignore and answered "not yet confirmed" — the same blind answer
 * this issue is about. `runtime-attach-eligibility.test.ts` holds the two rules together.
 *
 * Unreadable (a D1 error, a row that vanished): null, so the attach goes ahead and reports what the
 * machine does rather than inventing a reason.
 */
export async function attachBlocker(env: Pick<Env, "DB">, instanceId: string, userId: string): Promise<{ cause: "paused" | "not_active" | "no_runtime"; detail: string } | null> {
	let row: { status: string; slug: string | null; category: string | null; config: string | null } | null;
	try {
		row = await env.DB.prepare(
			"SELECT i.status, a.slug, a.category, a.config FROM agent_instances i JOIN agents a ON a.id = i.agent_id WHERE i.id = ?1 AND i.user_id = ?2",
		)
			.bind(instanceId, userId)
			.first();
	} catch {
		return null;
	}
	if (!row) return null;
	if (row.status === "paused") return { cause: "paused", detail: PAUSED_DETAIL };
	if (row.status !== "active") return { cause: "not_active", detail: NOT_ACTIVE_DETAIL };
	if (agentCapabilities({ slug: row.slug ?? "", category: row.category ?? "", config: row.config ?? "" }).runtime == null) return { cause: "no_runtime", detail: NO_RUNTIME_DETAIL };
	return null;
}
