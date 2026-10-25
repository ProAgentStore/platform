/**
 * Tell the owner about the other things a machine reports about itself, once per episode (#1191).
 *
 * #1162 pushes "this machine stopped reporting". These are the signals a machine that IS reporting carries, which stayed
 * pull-only (a warning on a page nobody had open): a runner crash-looping or a release rolled back (#1141, #1150), a sign-in about
 * to lapse (#1157), CPU / memory / disk pressure (#924). Each goes out as an `update` under the same mutable `machine` type —
 * one setting mutes the lot, and only the owner knows which of these is news.
 *
 * ONCE PER EPISODE, so a flapping signal is not a stream: `machine_warning_alerts` holds, per machine and kind, the episode
 * last told about and whether it still holds. Told at onset; cleared when a tick finds it gone, so its return is a new episode;
 * and a new episode inside {@link WARNING_REPEAT_MS} of the last push is held back (and told once the window passes, if it
 * still holds). A machine that is silent is #1162's business: only a machine that reported in the last
 * {@link FRESH_MS} is judged here, because its numbers are otherwise last week's.
 *
 * Also here: the all-clear #1162 left open — "back online", once, after a silence the owner was told about.
 */
import { deepLinkFor } from "./console-links.js";
import { MACHINE_SILENCE_LOOKBACK_MS, MACHINE_SILENT_MS } from "./machine-silence.js";
import { CPU_HIGH_WATER, DISK_HIGH_WATER_PCT, MEMORY_HIGH_WATER_PCT, memoryPressurePct, parseResourceSample, RESTARTS_HIGH_WATER, type RunnerResourceSample, SESSION_WARN_MS } from "./runner-resources.js";
import { parseRollbacks } from "./machine-policy.js";
import { notifyUser } from "../routes/push.js";
import type { Env } from "../types.js";

export const WARNING_KINDS = ["crash_loop", "rollback", "sign_in", "cpu", "memory", "disk"] as const;
export type WarningKind = (typeof WARNING_KINDS)[number];

/** A new episode of the same warning is not pushed again inside this window. */
export const WARNING_REPEAT_MS = 6 * 60 * 60_000;
/** A machine whose last report is older than this is judged by the silence sweep, not here. */
export const FRESH_MS = 15 * 60_000;
/** A rollback older than this is history, not news (and the first deploy must not announce every old one). */
export const ROLLBACK_NEWS_MS = 24 * 60 * 60_000;
const SWEEP_LIMIT = 1000;

const sqlTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
const sqlTimeMs = (v: string) => Date.parse(`${v.replace(" ", "T")}Z`);

export interface Signal {
	kind: WarningKind;
	/** Identifies the episode: a new value is a new episode even while the signal never cleared. */
	episode: string;
	title: string;
	body: string;
}

const left = (ms: number) => (ms >= 48 * 3600_000 ? `${Math.round(ms / 86_400_000)} days` : `${Math.max(1, Math.round(ms / 3_600_000))} hours`);

/**
 * The signals a machine's own report carries right now. Pure: every threshold is the one the page already warns at
 * (runner-resources.ts), so the push and the warning on the machine page can never disagree about when.
 */
export function machineSignals(name: string, sample: RunnerResourceSample | null, rollbacks: ReadonlyArray<{ from: string; to: string | null; reason: string; at: string | null }>, now: number): Signal[] {
	const out: Signal[] = [];
	if (sample?.runner && sample.runner.starts24h >= RESTARTS_HIGH_WATER) {
		out.push({
			kind: "crash_loop",
			episode: "on",
			title: `🟠 ${name}'s runner keeps restarting`,
			body: `It has started ${sample.runner.starts24h} times in 24 hours, which reads as a machine flickering between online and offline. Look at \`~/.config/proagentstore/update.log\` and the \`pags up\` window on that machine; \`pags up --install-service\` gives it a supervisor with backoff.`,
		});
	}
	const newest = [...rollbacks]
		.filter((r) => r.at && now - Date.parse(r.at) <= ROLLBACK_NEWS_MS)
		.sort((a, b) => Date.parse(b.at as string) - Date.parse(a.at as string))[0];
	if (newest) {
		out.push({
			kind: "rollback",
			episode: `${newest.from}@${newest.at}`,
			title: `🟠 ${name} rolled back ${newest.from}`,
			body: `It installed ${newest.from} and went back${newest.to ? ` to ${newest.to}` : ""}: ${newest.reason}. It will not install ${newest.from} again by itself; after a fix, Retry on the machine page (or runner_update with retry_rolled_back) tries it again.`,
		});
	}
	const expires = sample?.runner?.sessionExpiresAt;
	if (sample && expires && expires - sample.sampledAt <= SESSION_WARN_MS) {
		const gone = expires - sample.sampledAt;
		out.push({
			kind: "sign_in",
			episode: String(expires),
			title: gone <= 0 ? `🔴 ${name} is signed out` : `🟠 ${name}'s sign-in expires in ${left(gone)}`,
			body: gone <= 0
				? "Its sign-in has expired, so the runner cannot reach the platform. Run `pags login --device` on the machine (over SSH works), then restart `pags up`."
				: "A running runner renews its sign-in in its last 7 days, so one this close to expiry could not. Run `pags login --device` on the machine before then (over SSH works); `pags devices` shows each machine's sign-in.",
		});
	}
	if (sample?.loadAvg && sample.cpus > 0 && sample.loadAvg[0] / sample.cpus >= CPU_HIGH_WATER) {
		out.push({ kind: "cpu", episode: "on", title: `🟠 ${name} is CPU-saturated`, body: `1-minute load ${sample.loadAvg[0].toFixed(1)} on ${sample.cpus} cores. A runner this loaded answers its relay late — commands to it can fail as "not responding". Move agents to another machine or stop work running there.` });
	}
	const pressure = sample ? memoryPressurePct(sample) : null;
	if (pressure !== null && pressure >= MEMORY_HIGH_WATER_PCT) {
		out.push({ kind: "memory", episode: "on", title: `🟠 ${name} is nearly out of memory`, body: `${pressure}% in use. Expect slow or failed engine starts, clones and builds there; the machine page names the heaviest session.` });
	}
	const diskUsed = sample?.disk && sample.disk.totalBytes > 0 ? ((sample.disk.totalBytes - sample.disk.freeBytes) / sample.disk.totalBytes) * 100 : null;
	if (diskUsed !== null && diskUsed >= DISK_HIGH_WATER_PCT) {
		out.push({ kind: "disk", episode: "on", title: `🟠 ${name}'s disk is nearly full`, body: `${diskUsed.toFixed(1)}% of the checkout volume is in use. Clones, builds and git writes fail when it fills.` });
	}
	return out;
}

interface Row {
	user_id: string;
	machine_key: string;
	machine_id: string | null;
	runner_node: string;
	resources: string;
}

/**
 * The sweep, once a minute from the cron. Returns how many owners were notified. Claims each episode BEFORE sending, so an
 * overlapping tick cannot send it twice. Never throws on one machine's trouble.
 */
export async function notifyMachineWarnings(env: Env, now = Date.now()): Promise<number> {
	let rows: Row[];
	try {
		rows =
			(
				await env.DB.prepare(
					`SELECT user_id, COALESCE(NULLIF(machine_id, ''), runner_node) AS machine_key, machine_id, runner_node, resources
					   FROM instance_runtime_nodes
					  WHERE resources IS NOT NULL AND last_seen_at IS NOT NULL AND last_seen_at >= ?1
					  LIMIT ?2`,
				)
					.bind(sqlTime(now - FRESH_MS), SWEEP_LIMIT)
					.all<Row>()
			).results ?? [];
	} catch {
		return 0;
	}
	// One sample per machine: the freshest by the runner's own clock (a machine has a row per agent).
	const machines = new Map<string, { row: Row; sample: RunnerResourceSample }>();
	for (const row of rows) {
		const sample = parseResourceSample(row.resources);
		if (!sample) continue;
		const key = `${row.user_id}\u0000${row.machine_key}`;
		const have = machines.get(key);
		if (!have || sample.sampledAt > have.sample.sampledAt) machines.set(key, { row, sample });
	}
	let sent = 0;
	for (const { row, sample } of machines.values()) {
		try {
			const stored = row.machine_id ? (await env.DB.prepare("SELECT rollbacks FROM machine_policies WHERE user_id = ?1 AND machine_id = ?2").bind(row.user_id, row.machine_id).first<{ rollbacks: string | null }>())?.rollbacks : null;
			let parsed: unknown = null;
			try {
				parsed = stored ? JSON.parse(stored) : null;
			} catch {
				parsed = null; // an unreadable record is no rollback, and must not hide this machine's other signals
			}
			const rollbacks = parseRollbacks(parsed) ?? [];
			const active = new Map(machineSignals(row.runner_node, sample, rollbacks, now).map((s) => [s.kind, s]));
			for (const kind of WARNING_KINDS) {
				const signal = active.get(kind);
				if (!signal) {
					// Gone: close the episode so its return is a new one.
					await env.DB.prepare("UPDATE machine_warning_alerts SET active = 0 WHERE user_id = ?1 AND machine_key = ?2 AND kind = ?3 AND active = 1").bind(row.user_id, row.machine_key, kind).run();
					continue;
				}
				const claimed = await env.DB.prepare(
					`INSERT INTO machine_warning_alerts (user_id, machine_key, kind, episode_key, active, notified_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)
					 ON CONFLICT(user_id, machine_key, kind) DO UPDATE SET episode_key = excluded.episode_key, active = 1, notified_at = excluded.notified_at
					  WHERE (machine_warning_alerts.active = 0 OR machine_warning_alerts.episode_key <> excluded.episode_key)
					    AND machine_warning_alerts.notified_at <= ?6`,
				)
					.bind(row.user_id, row.machine_key, kind, signal.episode, now, now - WARNING_REPEAT_MS)
					.run();
				if (!claimed.meta?.changes) continue;
				await notifyUser(env, row.user_id, "machine", signal.title, signal.body, deepLinkFor({ kind: "machine", machineId: row.machine_id || null }), {
					key: `machine-warning:${row.machine_key}:${kind}:${signal.episode}`,
				}).catch(() => undefined);
				sent++;
			}
		} catch {
			// One machine's trouble must not stop the rest; it is retried on the next tick.
		}
	}
	return sent;
}

/**
 * The all-clear for #1162's silence alert (#1191): a machine the owner was told is silent that now reports again gets one
 * "back online". Claimed by setting `resolved_at` where it was null, so each silence is closed once; a new silence clears it
 * (machine-silence.ts), so the next return is told again. Returns how many owners were notified.
 */
export async function notifyRecoveredMachines(env: Env, now = Date.now()): Promise<number> {
	type Alert = { user_id: string; machine_key: string; last_seen_at: string; notified_at: number; fresh: string; machine_id: string | null; runner_node: string };
	let alerts: Alert[];
	try {
		alerts =
			(
				await env.DB.prepare(
					`SELECT a.user_id, a.machine_key, a.last_seen_at, a.notified_at,
					        (SELECT MAX(n.last_seen_at) FROM instance_runtime_nodes n WHERE n.user_id = a.user_id AND COALESCE(NULLIF(n.machine_id, ''), n.runner_node) = a.machine_key) AS fresh,
					        (SELECT n.machine_id FROM instance_runtime_nodes n WHERE n.user_id = a.user_id AND COALESCE(NULLIF(n.machine_id, ''), n.runner_node) = a.machine_key ORDER BY n.last_seen_at DESC LIMIT 1) AS machine_id,
					        (SELECT n.runner_node FROM instance_runtime_nodes n WHERE n.user_id = a.user_id AND COALESCE(NULLIF(n.machine_id, ''), n.runner_node) = a.machine_key ORDER BY n.last_seen_at DESC LIMIT 1) AS runner_node
					   FROM machine_silence_alerts a
					  WHERE a.resolved_at IS NULL AND a.notified_at >= ?2
					  LIMIT ?1`,
				)
					.bind(SWEEP_LIMIT, now - MACHINE_SILENCE_LOOKBACK_MS)
					.all<Alert>()
			).results ?? [];
	} catch {
		return 0;
	}
	let sent = 0;
	for (const a of alerts) {
		// Back = it has reported since the silence, and recently enough to be reporting now.
		if (!a.fresh || a.fresh <= a.last_seen_at || sqlTimeMs(a.fresh) < now - MACHINE_SILENT_MS) continue;
		try {
			const claimed = await env.DB.prepare("UPDATE machine_silence_alerts SET resolved_at = ?1 WHERE user_id = ?2 AND machine_key = ?3 AND resolved_at IS NULL AND last_seen_at = ?4")
				.bind(now, a.user_id, a.machine_key, a.last_seen_at)
				.run();
			if (!claimed.meta?.changes) continue;
			const away = Math.max(1, Math.round((sqlTimeMs(a.fresh) - sqlTimeMs(a.last_seen_at)) / 60_000));
			await notifyUser(env, a.user_id, "machine", `🟢 ${a.runner_node} is back online`, `It stopped reporting at ${a.last_seen_at} UTC and is reporting again after about ${away < 120 ? `${away} minutes` : `${Math.round(away / 60)} hours`}. Work that was waiting for it resumes by itself.`, deepLinkFor({ kind: "machine", machineId: a.machine_id || null }), {
				key: `machine-back:${a.machine_key}:${a.last_seen_at}`,
			}).catch(() => undefined);
			sent++;
		} catch {
			// retried next tick
		}
	}
	return sent;
}
