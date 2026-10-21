// The fleet's resource history in ONE response (#1259): every machine the caller owns, keyed by its stable id, with its display name,
// its latest reading, a slim point series for the chosen tier and — on a full load — a 24-hour summary for the table.
//
// Scope and secrecy. Everything is read for `userId` only, and the response is built from an explicit allow-list of fields: no
// endpoint, token, machine path, checkout path, session id or engine label reaches the page (a point carries numbers; `latest` is a
// hand-picked subset of the machine view). A machine is named by its owner's display name, else its freshest hostname.
//
// Live updates are a cursor, not a socket: `since` (epoch ms or ISO of the newest point the client holds) returns only newer points,
// so the page polls about every heartbeat (30s) and appends. A machine that stops reporting is `stale` — the client ends its line at
// the last point instead of drawing it flat.
import type { Env } from "../types.js";
import { machineDisplayNames } from "./machine-names.js";
import { adoptableIdByName, normalizeMachineId } from "./machine-identity.js";
import { normalizeRunnerNode } from "./runtime-nodes.js";
import { activeWorkOn, COARSE_RETENTION_MS, DENSE_RETENTION_MS, type HistoryTier, parseResourceSample, type ResourcePoint, resourceHistory, type RunnerResourceSample, resourcesView } from "./runner-resources.js";

/** A sample older than this is the last thing the machine said, not what it is doing (same bound the Terminals page uses). */
export const FLEET_STALE_MS = 3 * 60_000;
/** More machines than this are cut, newest first, and the answer says so. */
export const FLEET_MAX_MACHINES = 50;

/** A point as the fleet page needs it: numbers only. */
export interface FleetPoint {
	at: string;
	loadPerCpu: number | null;
	memUsedPct: number;
	diskUsedPct: number | null;
	relayRttMs: number | null;
	starts24h: number | null;
	sessionCount: number | null;
}

export interface FleetMachineLatest {
	sampledAt: string;
	cpus: number;
	loadPerCpu: number | null;
	memTotalBytes: number;
	memUsedPct: number;
	platform: string;
	activeSessions: number | null;
	recommendedMaxSessions: number;
	diskUsedPct: number | null;
	diskTotalBytes: number | null;
	relayRttMs: number | null;
	uptimeSec: number | null;
	starts24h: number | null;
	supervisor: "service" | "launcher" | "none" | null;
	gateState: string;
	warnings: string[];
}

export interface FleetSummary24h {
	/** 5-minute worst-of buckets in the window. */
	buckets: number;
	loadAvg: number | null;
	loadPeak: number | null;
	relayP50Ms: number | null;
	restarts: number | null;
}

export interface FleetMachine {
	/** The machine id, or `node:<hostname>` for one that never sent an id. Stable across renames; the series key. */
	key: string;
	machineId: string | null;
	name: string;
	node: string;
	aka: string[];
	lastSeenAt: string | null;
	sampledAt: string | null;
	/** True when there is no sample, or it is older than {@link FLEET_STALE_MS}: the machine is silent. */
	stale: boolean;
	sampleAgeSec: number | null;
	latest: FleetMachineLatest | null;
	points: FleetPoint[];
	/** Only on a full load (no `since`). */
	summary24h?: FleetSummary24h | null;
}

export interface FleetHistory {
	tier: HistoryTier;
	from: string;
	to: string;
	now: string;
	/** The newest point time across the fleet, ISO — hand it back as `since` to get only what is new. */
	cursor: string | null;
	truncated: boolean;
	machines: FleetMachine[];
}

const slim = (p: ResourcePoint): FleetPoint => ({ at: p.at, loadPerCpu: p.loadPerCpu, memUsedPct: p.memUsedPct, diskUsedPct: p.diskUsedPct, relayRttMs: p.relayRttMs, starts24h: p.starts24h, sessionCount: p.sessionCount });

const median = (xs: number[]): number | null => {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

/** The 24-hour table figures from the coarse tier. Load is the bucket's worst, so "avg" is the mean of 5-minute peaks. Pure. */
export function summarize24h(points: readonly Pick<ResourcePoint, "loadPerCpu" | "relayRttMs" | "starts24h">[]): FleetSummary24h | null {
	if (!points.length) return null;
	const loads = points.map((p) => p.loadPerCpu).filter((v): v is number => typeof v === "number");
	const rtts = points.map((p) => p.relayRttMs).filter((v): v is number => typeof v === "number");
	const starts = points.map((p) => p.starts24h).filter((v): v is number => typeof v === "number");
	const rtt = median(rtts);
	return {
		buckets: points.length,
		loadAvg: loads.length ? r2(loads.reduce((a, b) => a + b, 0) / loads.length) : null,
		loadPeak: loads.length ? r2(Math.max(...loads)) : null,
		relayP50Ms: rtt === null ? null : Math.round(rtt),
		restarts: starts.length ? Math.max(...starts) : null,
	};
}

/** `ms` from a query value (epoch ms or ISO); undefined when absent; NaN when present and unreadable. */
export function parseWhen(q: string | undefined): number | undefined {
	if (!q) return undefined;
	return /^\d+$/.test(q) ? Number(q) : Date.parse(q);
}

interface Row {
	instance_id: string;
	runner_node: string;
	machine_id: string | null;
	last_seen_at: string | null;
	resources: string | null;
}

const ms = (s: string | null): number => {
	if (!s) return 0;
	const t = Date.parse(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
	return Number.isFinite(t) ? t : 0;
};

export async function fleetHistory(env: Pick<Env, "DB">, userId: string, o: { tier: HistoryTier; from?: number; to?: number; since?: number; now?: number }): Promise<FleetHistory> {
	const now = o.now ?? Date.now();
	const retention = o.tier === "coarse" ? COARSE_RETENTION_MS : DENSE_RETENTION_MS;
	const to = o.to ?? now;
	let from = o.from ?? now - retention;
	if (o.since !== undefined) from = Math.max(from, o.since + 1); // exclusive cursor: only points newer than the client's newest
	const rows = ((await env.DB.prepare("SELECT instance_id, runner_node, machine_id, last_seen_at, resources FROM instance_runtime_nodes WHERE user_id = ?1").bind(userId).all<Row>()).results ?? []).filter((r) => normalizeRunnerNode(r.runner_node));
	const byName = adoptableIdByName(rows.map((r) => ({ node: r.runner_node, machineId: r.machine_id, instanceId: r.instance_id, lastSeenAt: r.last_seen_at })));
	const display = await machineDisplayNames(env, userId).catch(() => new Map<string, string>());

	interface Group { key: string; machineId: string | null; names: Map<string, number>; sample: RunnerResourceSample | null; raw: string | null }
	const groups = new Map<string, Group>();
	for (const r of rows) {
		const node = normalizeRunnerNode(r.runner_node);
		const machineId = normalizeMachineId(r.machine_id) || byName.get(node) || null;
		const key = machineId ?? `node:${node}`;
		const g = groups.get(key) ?? { key, machineId, names: new Map(), sample: null, raw: null };
		g.names.set(node, Math.max(g.names.get(node) ?? 0, ms(r.last_seen_at)));
		const s = parseResourceSample(r.resources);
		if (s && (!g.sample || s.sampledAt > g.sample.sampledAt)) {
			g.sample = s;
			g.raw = r.resources;
		}
		groups.set(key, g);
	}
	const ordered = [...groups.values()].sort((a, b) => Math.max(...b.names.values()) - Math.max(...a.names.values()));
	const kept = ordered.filter((_, i) => i < FLEET_MAX_MACHINES); // a cap that SAYS so: `truncated` below

	const machines = await Promise.all(
		kept.map(async (g): Promise<FleetMachine> => {
			const names = [...g.names.keys()];
			const freshest = [...g.names.entries()].sort((a, b) => b[1] - a[1])[0];
			const node = freshest?.[0] ?? names[0];
			const view = g.raw ? resourcesView(g.raw, await activeWorkOn(env, userId, names).catch(() => null)) : null;
			const sampledMs = view ? Date.parse(view.sampledAt) : null;
			const stale = sampledMs === null || now - sampledMs > FLEET_STALE_MS;
			const [points, coarse] = await Promise.all([
				resourceHistory(env, userId, names, o.tier, from, to).catch(() => []),
				o.since === undefined ? resourceHistory(env, userId, names, "coarse", now - COARSE_RETENTION_MS, now).catch(() => []) : Promise.resolve(null),
			]);
			const latest: FleetMachineLatest | null = view
				? {
						sampledAt: view.sampledAt,
						cpus: view.cpus,
						loadPerCpu: view.loadPerCpu,
						memTotalBytes: view.memTotalBytes,
						memUsedPct: view.memUsedPct,
						platform: view.platform,
						activeSessions: view.activeSessions,
						recommendedMaxSessions: view.recommendedMaxSessions,
						diskUsedPct: view.disk?.usedPct ?? null,
						diskTotalBytes: view.disk?.totalBytes ?? null,
						relayRttMs: view.relayRttMs,
						uptimeSec: view.runner?.uptimeSec ?? null,
						starts24h: view.runner?.starts24h ?? null,
						supervisor: view.runner?.supervisor ?? null,
						gateState: view.gateState,
						warnings: view.warnings,
					}
				: null;
			return {
				key: g.key,
				machineId: g.machineId,
				name: (g.machineId ? display.get(g.machineId) : undefined) ?? node,
				node,
				aka: names.filter((n) => n !== node),
				lastSeenAt: freshest?.[1] ? new Date(freshest[1]).toISOString() : null,
				sampledAt: view?.sampledAt ?? null,
				stale,
				sampleAgeSec: sampledMs === null ? null : Math.max(0, Math.round((now - sampledMs) / 1000)),
				latest,
				points: points.map(slim),
				...(coarse ? { summary24h: summarize24h(coarse) } : {}),
			};
		}),
	);
	const newest = machines.flatMap((m) => m.points.map((p) => Date.parse(p.at))).filter(Number.isFinite);
	return {
		tier: o.tier,
		from: new Date(from).toISOString(),
		to: new Date(to).toISOString(),
		now: new Date(now).toISOString(),
		cursor: newest.length ? new Date(Math.max(...newest)).toISOString() : null,
		truncated: ordered.length > kept.length,
		machines,
	};
}
