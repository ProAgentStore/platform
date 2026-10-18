/**
 * Tell the owner when a runner machine goes silent (#1162).
 *
 * A machine that stops heartbeating used to show only as a grey dot: on 2026-10-17/18 three were dark
 * for hours and the owner found out by looking. The one sweep that noticed a silent machine — mid-update,
 * `failSilentUpdates` — wrote an error_log row, which nobody is pushed. This sweep covers every machine,
 * mid-update included, and sends the owner one notification per silence, with the machine's last report
 * and what fixes it.
 *
 *   * WHICH machines: the owner's runtime registrations (`instance_runtime_nodes`) grouped by machine — its
 *     stable id when the runner sends one, else its hostname — and judged by the FRESHEST `last_seen_at`
 *     across them, so one agent detached from a machine that is still up does not read as the machine.
 *   * WHEN: silent for {@link MACHINE_SILENT_MS}, and only within {@link MACHINE_SILENCE_LOOKBACK_MS} of
 *     going quiet — a machine retired months ago is not news, and the first deploy must not page the
 *     owner about every laptop they ever registered.
 *   * ONCE: `machine_silence_alerts` records the `last_seen_at` it was told about. The same silence never
 *     notifies twice; the machine reporting again and going quiet later is a new silence and does.
 *   * Mutable: an `update`, under the `machine` type the owner can mute — a machine asleep at night is
 *     news to some owners and noise to others, and only they know which.
 */
import { deepLinkFor } from "./console-links.js";
import { getMachinePolicy, silentAfterInstall } from "./machine-policy.js";
import { notifyUser } from "../routes/push.js";
import type { Env } from "../types.js";

/** Silence that is a machine down, not a blip: past a restart, a wifi handover or a quick update. */
export const MACHINE_SILENT_MS = 15 * 60_000;

/** How long after going quiet a machine is still worth telling about. */
export const MACHINE_SILENCE_LOOKBACK_MS = 24 * 60 * 60_000;

/** Machines checked per tick — a bound on the sweep, not a product limit. */
const SWEEP_LIMIT = 200;

/** `last_seen_at`'s own format: `datetime('now')`, UTC, to the second. */
function sqlTime(ms: number): string {
	return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function sqlTimeMs(value: string): number {
	return Date.parse(`${value.replace(" ", "T")}Z`);
}

function silentFor(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 120) return `${minutes} minutes`;
	return `${Math.round(minutes / 60)} hours`;
}

interface SilentMachine {
	user_id: string;
	machine_key: string;
	machine_id: string | null;
	runner_node: string;
	runner_version: string | null;
	last_seen_at: string;
	agents: number;
}

/** The notification for one silent machine — title, body. Pure: its words are tested on their own. */
export function silentMachineMessage(
	m: Pick<SilentMachine, "runner_node" | "runner_version" | "last_seen_at" | "agents">,
	update: { midUpdate: boolean; latestVersion: string | null },
	now: number,
): { title: string; body: string } {
	const quiet = silentFor(now - sqlTimeMs(m.last_seen_at));
	const report = `Last heard from ${quiet} ago (${m.last_seen_at} UTC)${m.runner_version ? `, running pags ${m.runner_version}` : ""}, serving ${m.agents} agent${m.agents === 1 ? "" : "s"}.`;
	if (update.midUpdate) {
		return {
			title: `🔴 ${m.runner_node} went silent during an update`,
			body: `${report} It stopped reporting while installing an automatic update${update.latestVersion ? ` to ${update.latestVersion}` : ""}. Restart \`pags up\` on that machine; \`pags up --install-service\` installs a supervisor that restarts it by itself next time.`,
		};
	}
	return {
		title: `🔴 ${m.runner_node} stopped reporting`,
		body: `${report} If it is asleep or switched off, nothing is lost: runs on it wait for it, and queued work starts when it reconnects. Otherwise start \`pags up\` there — \`pags up --install-service\` keeps it running.`,
	};
}

/**
 * The sweep, once a minute from the cron. Returns how many owners were notified. Claims each silence
 * BEFORE sending, so an overlapping tick cannot send it twice.
 */
export async function notifySilentMachines(env: Env, now = Date.now()): Promise<number> {
	// One MAX() aggregate, so SQLite takes the bare columns (hostname, id, version) from the freshest row.
	const silent =
		(
			await env.DB.prepare(
				`SELECT user_id, COALESCE(NULLIF(machine_id, ''), runner_node) AS machine_key, machine_id, runner_node, runner_version,
				        MAX(last_seen_at) AS last_seen_at, COUNT(DISTINCT instance_id) AS agents
				   FROM instance_runtime_nodes
				  WHERE last_seen_at IS NOT NULL
				  GROUP BY user_id, machine_key
				 HAVING MAX(last_seen_at) <= ?1 AND MAX(last_seen_at) >= ?2
				  LIMIT ?3`,
			)
				.bind(sqlTime(now - MACHINE_SILENT_MS), sqlTime(now - MACHINE_SILENCE_LOOKBACK_MS), SWEEP_LIMIT)
				.all<SilentMachine>()
		).results ?? [];
	let sent = 0;
	for (const m of silent) {
		const claimed = await env.DB.prepare(
			`INSERT INTO machine_silence_alerts (user_id, machine_key, last_seen_at, notified_at) VALUES (?1, ?2, ?3, ?4)
			 ON CONFLICT(user_id, machine_key) DO UPDATE SET last_seen_at = excluded.last_seen_at, notified_at = excluded.notified_at
			  WHERE machine_silence_alerts.last_seen_at <> excluded.last_seen_at`,
		)
			.bind(m.user_id, m.machine_key, m.last_seen_at, now)
			.run();
		if (!claimed.meta?.changes) continue;
		const policy = await getMachinePolicy(env, m.user_id, m.machine_id);
		const { title, body } = silentMachineMessage(m, { midUpdate: silentAfterInstall(policy, now), latestVersion: policy.latestVersion }, now);
		await notifyUser(env, m.user_id, "machine", title, body, deepLinkFor({ kind: "machine", machineId: m.machine_id || null }), {
			key: `machine-silent:${m.machine_key}:${m.last_seen_at}`,
		}).catch(() => undefined);
		sent++;
	}
	return sent;
}
