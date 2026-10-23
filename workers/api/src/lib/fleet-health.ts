/**
 * Fleet visibility without a manual check (#1320).
 *
 * Every machine that is online is judged on four things, and a failure raises ONE alert per episode (cleared when it
 * recovers) instead of waiting for someone to look:
 *   • capability_missing — it has been online a while and has never reported what it can do (#1312);
 *   • capability_stale   — its report is older than a day and a half although it is online (the runner re-sends daily);
 *   • version_drift      — a release has been out for a while and the machine is not on it;
 *   • update_failed      — its updater reported a failed update;
 *   • crash_loop         — its runner has started many times in 24 hours.
 *
 * Judged from facts the platform already holds (the node rows, the stored capability record, the machine policy) plus the newest
 * published release, fetched at most hourly. Pure decisions are exported for tests; the cron entry never throws.
 */
import { notifyUser } from "../routes/push.js";
import type { Env } from "../types.js";
import { deepLinkFor } from "./console-links.js";
import { logEvent } from "./events.js";
import { olderVersion } from "./fleet-version.js";
import { parseResourceSample } from "./runner-resources.js";

export type FleetAlertKind = "capability_missing" | "capability_stale" | "version_drift" | "update_failed" | "crash_loop";

/** Seen by a heartbeat this recently counts as online. */
export const ONLINE_MS = 15 * 60_000;
/** An online machine gets this long, from its first registration, to report capabilities before it is an alert. */
export const CAPABILITY_GRACE_MS = 30 * 60_000;
export const CAPABILITY_STALE_MS = 36 * 3_600_000;
/** A release gets this long to reach a machine before a machine still on the old one is "drifting". */
export const DRIFT_GRACE_MS = 12 * 3_600_000;
export const CRASH_LOOP_STARTS_24H = 5;
export const RELEASE_CHECK_MS = 60 * 60_000;
const REGISTRY_URL = "https://registry.npmjs.org/@proagentstore%2fcli/latest";

export interface MachineFacts {
	userId: string;
	machineId: string;
	label: string;
	instanceId: string;
	lastSeenAt: number;
	firstRegisteredAt: number;
	runnerVersion: string | null;
	starts24h: number | null;
	capabilityAt: number | null;
	updateStatus: string | null;
	updateError: string | null;
}

/** What is wrong with this machine right now. Pure. */
export function judgeMachine(m: MachineFacts, release: { version: string; firstSeenAt: number } | null, now: number): Array<{ kind: FleetAlertKind; detail: string }> {
	if (now - m.lastSeenAt > ONLINE_MS) return []; // an offline machine has its own alarm (machine-silence); nothing here is judged of one
	const out: Array<{ kind: FleetAlertKind; detail: string }> = [];
	if (m.capabilityAt === null) {
		if (now - m.firstRegisteredAt > CAPABILITY_GRACE_MS) out.push({ kind: "capability_missing", detail: `${m.label} is online but has never reported its capabilities. Its runner is probably older than the capability report; it updates itself, or run \`pags update\` there.` });
	} else if (now - m.capabilityAt > CAPABILITY_STALE_MS) {
		out.push({ kind: "capability_stale", detail: `${m.label}'s capability report is ${Math.floor((now - m.capabilityAt) / 3_600_000)} hours old although the machine is online; it should re-send daily.` });
	}
	if (release && m.runnerVersion && olderVersion(m.runnerVersion, release.version) && now - release.firstSeenAt > DRIFT_GRACE_MS) {
		out.push({ kind: "version_drift", detail: `${m.label} runs ${m.runnerVersion}; ${release.version} has been out for ${Math.floor((now - release.firstSeenAt) / 3_600_000)} hours.` });
	}
	if (m.updateStatus === "failed") out.push({ kind: "update_failed", detail: `${m.label}'s last update failed${m.updateError ? `: ${m.updateError}` : ""}. It was rolled back or left on its current version.` });
	if (m.starts24h !== null && m.starts24h >= CRASH_LOOP_STARTS_24H) out.push({ kind: "crash_loop", detail: `${m.label}'s runner started ${m.starts24h} times in 24 hours, which is a crash loop or a restart storm.` });
	return out;
}

interface NodeRow {
	user_id: string;
	instance_id: string;
	runner_node: string;
	runner_version: string | null;
	machine_id: string;
	last_seen_at: string | null;
	created_at: string | null;
	resources: string | null;
}

const ms = (s: string | null): number => {
	if (!s) return 0;
	const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(s) ? `${s.replace(" ", "T")}Z` : s);
	return Number.isFinite(t) ? t : 0;
};

/** One fact record per machine that has an id, from the freshest of its node rows. */
export async function collectMachineFacts(env: Pick<Env, "DB">): Promise<MachineFacts[]> {
	const { results } = await env.DB.prepare(
		`SELECT user_id, instance_id, runner_node, runner_version, machine_id, last_seen_at, created_at, resources FROM instance_runtime_nodes
		  WHERE machine_id IS NOT NULL AND machine_id <> '' AND last_seen_at IS NOT NULL`,
	).all<NodeRow>();
	const by = new Map<string, { fresh: NodeRow; first: number }>();
	for (const r of results ?? []) {
		const key = `${r.user_id}\u0000${r.machine_id}`;
		const cur = by.get(key);
		const created = ms(r.created_at) || ms(r.last_seen_at);
		if (!cur) by.set(key, { fresh: r, first: created });
		else {
			cur.first = Math.min(cur.first, created);
			if (ms(r.last_seen_at) > ms(cur.fresh.last_seen_at)) cur.fresh = r;
		}
	}
	const caps = new Map<string, number>();
	const capRows = await env.DB.prepare("SELECT user_id, machine_id, updated_at FROM machine_capabilities").all<{ user_id: string; machine_id: string; updated_at: string }>().catch(() => ({ results: [] as Array<{ user_id: string; machine_id: string; updated_at: string }> }));
	for (const c of capRows.results ?? []) caps.set(`${c.user_id}\u0000${c.machine_id}`, ms(c.updated_at));
	const pol = new Map<string, { status: string; last_error: string | null; display_name: string | null }>();
	const polRows = await env.DB.prepare("SELECT user_id, machine_id, status, last_error, display_name FROM machine_policies").all<{ user_id: string; machine_id: string; status: string; last_error: string | null; display_name: string | null }>().catch(() => ({ results: [] as Array<{ user_id: string; machine_id: string; status: string; last_error: string | null; display_name: string | null }> }));
	for (const p of polRows.results ?? []) pol.set(`${p.user_id}\u0000${p.machine_id}`, p);
	const display = new Map([...pol].map(([k, p]) => [k, p.display_name] as const));
	return [...by.entries()].map(([key, { fresh, first }]) => ({
		userId: fresh.user_id,
		machineId: fresh.machine_id,
		label: display.get(key) || fresh.runner_node,
		instanceId: fresh.instance_id,
		lastSeenAt: ms(fresh.last_seen_at),
		firstRegisteredAt: first,
		runnerVersion: fresh.runner_version || null,
		starts24h: parseResourceSample(fresh.resources)?.runner?.starts24h ?? null,
		capabilityAt: caps.get(key) ?? null,
		updateStatus: pol.get(key)?.status ?? null,
		updateError: pol.get(key)?.last_error ?? null,
	}));
}

export interface ReleaseDeps {
	fetchLatest?: () => Promise<string | null>;
}

/** The newest published release and when the platform first saw it; checked at most hourly, and a failed check keeps what it had. */
export async function currentRelease(env: Pick<Env, "DB">, now: number, deps: ReleaseDeps = {}): Promise<{ version: string; firstSeenAt: number } | null> {
	const row = await env.DB.prepare("SELECT version, first_seen_at, checked_at FROM fleet_release_state WHERE id = 1").first<{ version: string; first_seen_at: number; checked_at: number }>().catch(() => null);
	if (row && now - row.checked_at < RELEASE_CHECK_MS) return { version: row.version, firstSeenAt: row.first_seen_at };
	const latest = await (deps.fetchLatest ?? fetchLatestRelease)().catch(() => null);
	if (!latest || !/^\d+\.\d+\.\d+/.test(latest)) return row ? { version: row.version, firstSeenAt: row.first_seen_at } : null;
	const firstSeen = row && row.version === latest ? row.first_seen_at : now;
	await env.DB.prepare("INSERT INTO fleet_release_state (id, version, first_seen_at, checked_at) VALUES (1, ?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET version = excluded.version, first_seen_at = excluded.first_seen_at, checked_at = excluded.checked_at").bind(latest, firstSeen, now).run();
	return { version: latest, firstSeenAt: firstSeen };
}

async function fetchLatestRelease(): Promise<string | null> {
	const res = await fetch(REGISTRY_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
	if (!res.ok) return null;
	const body = (await res.json().catch(() => null)) as { version?: unknown } | null;
	return typeof body?.version === "string" ? body.version : null;
}

const TITLE: Record<FleetAlertKind, string> = {
	capability_missing: "A machine has not reported its capabilities",
	capability_stale: "A machine's capability report is stale",
	version_drift: "A machine is behind the latest release",
	update_failed: "A machine's update failed",
	crash_loop: "A machine's runner keeps restarting",
};

export interface FleetPassResult { machines: number; raised: number; cleared: number }

/** One pass: judge every machine, raise what is newly wrong (once), clear what recovered. Never throws. */
export async function runFleetHealth(env: Env, deps: ReleaseDeps & { now?: () => number; notify?: typeof notifyUser } = {}): Promise<FleetPassResult> {
	const now = (deps.now ?? Date.now)();
	const out: FleetPassResult = { machines: 0, raised: 0, cleared: 0 };
	try {
		const release = await currentRelease(env, now, deps);
		const machines = await collectMachineFacts(env);
		out.machines = machines.length;
		const notify = deps.notify ?? notifyUser;
		for (const m of machines) {
			const wrong = new Map(judgeMachine(m, release, now).map((w) => [w.kind, w.detail] as const));
			const { results: open } = await env.DB.prepare("SELECT kind FROM fleet_alerts WHERE user_id = ?1 AND machine_id = ?2 AND cleared_at IS NULL").bind(m.userId, m.machineId).all<{ kind: FleetAlertKind }>();
			const openKinds = new Set((open ?? []).map((o) => o.kind));
			// An offline machine keeps its open alerts as they are: silence is judged elsewhere, and clearing on absence would lie.
			const online = now - m.lastSeenAt <= ONLINE_MS;
			for (const [kind, detail] of wrong) {
				if (openKinds.has(kind)) continue;
				await env.DB.prepare("INSERT INTO fleet_alerts (user_id, machine_id, kind, detail, raised_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(m.userId, m.machineId, kind, detail, now).run();
				out.raised++;
				await logEvent(env, { source: "fleet", event: `fleet.${kind}`, level: "warn", userId: m.userId, instanceId: m.instanceId, message: detail, context: { machineId: m.machineId, kind } }).catch(() => undefined);
				await notify(env, m.userId, "runner_fleet", TITLE[kind], detail, deepLinkFor({ kind: "machine", machineId: m.machineId }), { kind: "alert", instanceId: m.instanceId, key: `fleet:${m.machineId}:${kind}` }).catch(() => undefined);
			}
			if (online) {
				for (const kind of openKinds) {
					if (wrong.has(kind)) continue;
					await env.DB.prepare("UPDATE fleet_alerts SET cleared_at = ?4 WHERE user_id = ?1 AND machine_id = ?2 AND kind = ?3 AND cleared_at IS NULL").bind(m.userId, m.machineId, kind, now).run();
					out.cleared++;
					await logEvent(env, { source: "fleet", event: `fleet.${kind}_cleared`, level: "info", userId: m.userId, instanceId: m.instanceId, message: `${m.label}: ${kind.replace("_", " ")} recovered`, context: { machineId: m.machineId, kind } }).catch(() => undefined);
				}
			}
		}
	} catch {
		// The next tick looks again; a failed pass must not fail the cron.
	}
	return out;
}
