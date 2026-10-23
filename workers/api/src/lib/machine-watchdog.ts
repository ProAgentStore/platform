/**
 * The platform side of the always-on control channel (#1320).
 *
 * A watchdog service on each machine is independent of the `pags up` runner: it keeps its own heartbeat with the platform, so
 * a machine whose runner is dead (or never started) can still be updated, restarted, rolled back and asked a diagnostic.
 * The heartbeat carries the watchdog's status up, results of earlier commands up, and — in the answer — the commands queued for
 * it. Nothing here runs a command: the platform only queues one of a CLOSED set of kinds with validated arguments, and the
 * watchdog executes only those kinds. Every queue, delivery and result is written to the audit log.
 */
import type { Env } from "../types.js";
import { logEvent } from "./events.js";
import { storedCapabilityHash, upsertMachineCapabilities } from "./machine-capabilities.js";
import { clipMarked } from "./clip-marked.js";
import { scrub } from "./machine-capability-schema.js";

export const WATCHDOG_KINDS = ["status", "update", "restart", "rollback", "diagnose"] as const;
export type WatchdogKind = (typeof WATCHDOG_KINDS)[number];
/** What `diagnose` may ask for. A closed list: there is no command line anywhere in this channel. */
export const DIAGNOSE_CHECKS = ["disk", "node", "payloads", "runner", "service", "log_tail"] as const;
export type DiagnoseCheck = (typeof DIAGNOSE_CHECKS)[number];

/** A queued command nobody collected within this long is dropped; a delivered one with no result within the second is too. */
export const QUEUED_TTL_MS = 24 * 3_600_000;
export const DELIVERED_TTL_MS = 30 * 60_000;
export const MAX_DELIVERED_PER_BEAT = 3;
/** A watchdog heard from within this long counts as connected. */
export const WATCHDOG_ONLINE_MS = 5 * 60_000;

export interface WatchdogStatus {
	/** The watchdog's own CLI version. */
	version: string | null;
	uptimeSec: number | null;
	/** Is a `pags up` runner process alive here, and since when. */
	runner: { alive: boolean; uptimeSec: number | null };
	/** The newest cached release and the others kept for rollback. */
	running: string | null;
	payloads: string[];
	/** A release on trial, or null. */
	trial: { version: string; startsLeft: number | null } | null;
	/** The last automatic rollback, if one has not been reported yet. */
	rollback: { from: string; to: string | null; reason: string } | null;
	crashes24h: number | null;
	lastError: string | null;
	cpuLoad1: number | null;
	memUsedPct: number | null;
	diskUsedPct: number | null;
	nodeVersion: string | null;
	service: "launchd" | "systemd" | "scheduled-task" | "unmanaged" | null;
}

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?$/;
const short = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? scrub(v, max) : null);
const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v * 10) / 10 : null);
const ver = (v: unknown): string | null => (typeof v === "string" && VERSION.test(v.trim()) ? v.trim() : null);

/** Validate and clamp a watchdog's status. Anything unreadable becomes null, never an error: a heartbeat is not refused for its telemetry. */
export function parseWatchdogStatus(raw: unknown): WatchdogStatus {
	const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const runner = r.runner && typeof r.runner === "object" ? (r.runner as Record<string, unknown>) : {};
	const trial = r.trial && typeof r.trial === "object" ? (r.trial as Record<string, unknown>) : null;
	const rb = r.rollback && typeof r.rollback === "object" ? (r.rollback as Record<string, unknown>) : null;
	const service = r.service === "launchd" || r.service === "systemd" || r.service === "scheduled-task" || r.service === "unmanaged" ? r.service : null;
	const trialVersion = trial ? ver(trial.version) : null;
	const from = rb ? ver(rb.from) : null;
	return {
		version: ver(r.version),
		uptimeSec: num(r.uptimeSec, 0, 1e9),
		runner: { alive: runner.alive === true, uptimeSec: num(runner.uptimeSec, 0, 1e9) },
		running: ver(r.running),
		payloads: (Array.isArray(r.payloads) ? r.payloads : []).map(ver).filter((v): v is string => !!v).filter((_, i) => i < 5),
		trial: trialVersion ? { version: trialVersion, startsLeft: num(trial?.startsLeft, 0, 100) } : null,
		rollback: from ? { from, to: ver(rb?.to), reason: short(rb?.reason, 200) ?? "" } : null,
		crashes24h: num(r.crashes24h, 0, 100_000),
		lastError: short(r.lastError, 200),
		cpuLoad1: num(r.cpuLoad1, 0, 1000),
		memUsedPct: num(r.memUsedPct, 0, 100),
		diskUsedPct: num(r.diskUsedPct, 0, 100),
		nodeVersion: ver(r.nodeVersion),
		service,
	};
}

export interface WatchdogCommand {
	id: string;
	kind: WatchdogKind;
	args: Record<string, string>;
}

/** Validate a requested command. Pure. */
export function parseWatchdogCommand(kind: unknown, args: unknown): { ok: true; kind: WatchdogKind; args: Record<string, string> } | { ok: false; error: string } {
	if (typeof kind !== "string" || !(WATCHDOG_KINDS as readonly string[]).includes(kind)) return { ok: false, error: `kind must be one of ${WATCHDOG_KINDS.join(", ")}.` };
	const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
	const unknown = Object.keys(a).filter((k) => !(kind === "update" ? ["version"] : kind === "diagnose" ? ["check"] : []).includes(k));
	if (unknown.length) return { ok: false, error: `${kind} takes no argument named ${unknown.join(", ")}.` };
	if (kind === "update") {
		if (a.version === undefined) return { ok: true, kind, args: {} };
		const v = ver(a.version);
		return v ? { ok: true, kind, args: { version: v } } : { ok: false, error: "update version must be a release like 0.4.178 (omit it for the latest)." };
	}
	if (kind === "diagnose") {
		const c = a.check;
		return typeof c === "string" && (DIAGNOSE_CHECKS as readonly string[]).includes(c) ? { ok: true, kind, args: { check: c } } : { ok: false, error: `diagnose check must be one of ${DIAGNOSE_CHECKS.join(", ")}.` };
	}
	return { ok: true, kind: kind as WatchdogKind, args: {} };
}

export interface QueuedCommand { id: string; kind: WatchdogKind; args: Record<string, string>; state: string; createdAt: number; deliveredAt: number | null; finishedAt: number | null; result: string | null; requestedBy: string }

interface CommandRow { id: string; kind: WatchdogKind; args: string; state: string; created_at: number; delivered_at: number | null; finished_at: number | null; result: string | null; requested_by: string }
const view = (r: CommandRow): QueuedCommand => {
	let args: Record<string, string> = {};
	try {
		const p = JSON.parse(r.args);
		if (p && typeof p === "object") args = p as Record<string, string>;
	} catch {
		// a corrupt row reads as no arguments
	}
	return { id: r.id, kind: r.kind, args, state: r.state, createdAt: r.created_at, deliveredAt: r.delivered_at, finishedAt: r.finished_at, result: r.result, requestedBy: r.requested_by };
};

/** Queue a command for a machine's watchdog. Idempotent per kind: one already waiting or running is returned, not doubled. */
export async function enqueueWatchdogCommand(env: Env, userId: string, machineId: string, kind: unknown, args: unknown, now = Date.now()): Promise<{ ok: true; command: QueuedCommand; duplicate: boolean } | { ok: false; error: string }> {
	const parsed = parseWatchdogCommand(kind, args);
	if (!parsed.ok) return parsed;
	const open = await env.DB.prepare("SELECT * FROM machine_watchdog_commands WHERE user_id = ?1 AND machine_id = ?2 AND kind = ?3 AND state IN ('queued', 'delivered') ORDER BY created_at DESC LIMIT 1").bind(userId, machineId, parsed.kind).first<CommandRow>();
	if (open) return { ok: true, command: view(open), duplicate: true };
	const id = crypto.randomUUID();
	await env.DB.prepare("INSERT INTO machine_watchdog_commands (id, user_id, machine_id, kind, args, requested_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(id, userId, machineId, parsed.kind, JSON.stringify(parsed.args), userId, now).run();
	await logEvent(env, { source: "watchdog", event: "watchdog.command_queued", level: "info", userId, message: `queued ${parsed.kind} for machine ${machineId.split("-")[0]}`, context: { machineId, commandId: id, kind: parsed.kind, args: parsed.args } }).catch(() => undefined);
	const row = await env.DB.prepare("SELECT * FROM machine_watchdog_commands WHERE id = ?1").bind(id).first<CommandRow>();
	return { ok: true, command: view(row as CommandRow), duplicate: false };
}

export interface HeartbeatBody { status?: unknown; results?: unknown; capabilities?: unknown; capabilityHash?: unknown }
export interface HeartbeatAnswer { commands: WatchdogCommand[]; capabilitiesStored?: true; capabilitiesWanted?: true }

/** One heartbeat: store the status, settle reported results, expire what is stale, hand out what is queued, take the capability report. */
export async function watchdogHeartbeat(env: Env, userId: string, machineId: string, body: HeartbeatBody, now = Date.now()): Promise<HeartbeatAnswer> {
	const status = parseWatchdogStatus(body.status);
	await env.DB.prepare(
		`INSERT INTO machine_watchdog_status (user_id, machine_id, reported_at, first_seen_at, version, status_json) VALUES (?1, ?2, ?3, ?3, ?4, ?5)
		 ON CONFLICT(user_id, machine_id) DO UPDATE SET reported_at = excluded.reported_at, version = excluded.version, status_json = excluded.status_json`,
	).bind(userId, machineId, now, status.version, JSON.stringify(status)).run();

	for (const r of (Array.isArray(body.results) ? body.results : []).filter((_, i) => i < 10)) {
		const o = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
		const id = typeof o.id === "string" ? o.id : "";
		const state = o.state === "done" ? "done" : o.state === "failed" ? "failed" : null;
		if (!id || !state) continue;
		const detail = clipMarked(scrub(o.detail, 2000), 1500, { within: true });
		// Only a command this machine was actually handed can be settled, and only once.
		const res = await env.DB.prepare("UPDATE machine_watchdog_commands SET state = ?4, finished_at = ?5, result = ?6 WHERE id = ?1 AND user_id = ?2 AND machine_id = ?3 AND state = 'delivered'").bind(id, userId, machineId, state, now, detail).run();
		if ((res.meta?.changes ?? 0) > 0) await logEvent(env, { source: "watchdog", event: "watchdog.command_result", level: state === "done" ? "info" : "warn", userId, message: `command ${id.slice(0, 8)} ${state}`, context: { machineId, commandId: id, state, result: clipMarked(detail, 500, { within: true }) } }).catch(() => undefined);
	}

	await env.DB.prepare("UPDATE machine_watchdog_commands SET state = 'expired', finished_at = ?4, result = 'never collected' WHERE user_id = ?1 AND machine_id = ?2 AND state = 'queued' AND created_at < ?3").bind(userId, machineId, now - QUEUED_TTL_MS, now).run();
	await env.DB.prepare("UPDATE machine_watchdog_commands SET state = 'expired', finished_at = ?4, result = 'no result was reported' WHERE user_id = ?1 AND machine_id = ?2 AND state = 'delivered' AND delivered_at < ?3").bind(userId, machineId, now - DELIVERED_TTL_MS, now).run();

	const { results } = await env.DB.prepare("SELECT * FROM machine_watchdog_commands WHERE user_id = ?1 AND machine_id = ?2 AND state = 'queued' ORDER BY created_at ASC LIMIT ?3").bind(userId, machineId, MAX_DELIVERED_PER_BEAT).all<CommandRow>();
	const commands: WatchdogCommand[] = [];
	for (const row of results ?? []) {
		const claim = await env.DB.prepare("UPDATE machine_watchdog_commands SET state = 'delivered', delivered_at = ?2 WHERE id = ?1 AND state = 'queued'").bind(row.id, now).run();
		if ((claim.meta?.changes ?? 0) === 0) continue;
		const c = view(row);
		commands.push({ id: c.id, kind: c.kind, args: c.args });
		await logEvent(env, { source: "watchdog", event: "watchdog.command_delivered", level: "info", userId, message: `delivered ${c.kind} to machine ${machineId.split("-")[0]}`, context: { machineId, commandId: c.id, kind: c.kind } }).catch(() => undefined);
	}

	const answer: HeartbeatAnswer = { commands };
	// The capability report rides this heartbeat too, so a machine whose runner is dead, old or never started still reports (#1312).
	if (body.capabilities) await upsertMachineCapabilities(env, userId, machineId, body.capabilities).catch(() => undefined);
	if (typeof body.capabilityHash === "string") {
		const held = await storedCapabilityHash(env, userId, machineId).catch(() => null);
		if (held === body.capabilityHash) answer.capabilitiesStored = true;
		else answer.capabilitiesWanted = true;
	}
	return answer;
}

export async function readWatchdog(env: Env, userId: string, machineId: string, now = Date.now()): Promise<{ installed: boolean; connected: boolean; reportedAt: number | null; firstSeenAt: number | null; status: WatchdogStatus | null; commands: QueuedCommand[] }> {
	const row = await env.DB.prepare("SELECT reported_at, first_seen_at, status_json FROM machine_watchdog_status WHERE user_id = ?1 AND machine_id = ?2").bind(userId, machineId).first<{ reported_at: number; first_seen_at: number; status_json: string }>();
	const { results } = await env.DB.prepare("SELECT * FROM machine_watchdog_commands WHERE user_id = ?1 AND machine_id = ?2 ORDER BY created_at DESC LIMIT 20").bind(userId, machineId).all<CommandRow>();
	let status: WatchdogStatus | null = null;
	if (row) {
		try {
			status = parseWatchdogStatus(JSON.parse(row.status_json));
		} catch {
			status = null;
		}
	}
	return { installed: !!row, connected: !!row && now - row.reported_at <= WATCHDOG_ONLINE_MS, reportedAt: row?.reported_at ?? null, firstSeenAt: row?.first_seen_at ?? null, status, commands: (results ?? []).map(view) };
}
