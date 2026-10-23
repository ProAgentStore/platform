/**
 * Storage and enforcement for the per-machine capability record (#1312).
 *
 * `upsertMachineCapabilities` validates, hashes and stores a runner's report, and when the hash differs from
 * the stored one appends what changed to `machine_capability_history`. `checkJobCapabilityRequirements` is the
 * fail-fast gate: a job that names requirements is refused, with the missing thing named, rather than started
 * on a machine that cannot run it.
 */
import type { Env } from "../types.js";
import { checkBrowserCompatibility, checkCapabilityRequirements } from "./machine-capability-compat.js";
import { BROWSER_ENGINES, type BrowserEngine, capabilityHash, diffCapabilities, type MachineCapabilities, parseMachineCapabilities } from "./machine-capability-schema.js";

type Db = Pick<Env, "DB">;
/** History kept per machine; older rows are pruned on write. */
export const HISTORY_KEEP = 50;

export interface StoredCapabilities {
	machineId: string;
	hash: string;
	updatedAt: string;
	capabilities: MachineCapabilities;
}

export async function getMachineCapabilities(env: Db, userId: string, machineId: string): Promise<StoredCapabilities | null> {
	if (!machineId) return null;
	const row = await env.DB.prepare("SELECT raw_json, capability_hash, updated_at FROM machine_capabilities WHERE machine_id = ?1 AND user_id = ?2")
		.bind(machineId, userId)
		.first<{ raw_json: string; capability_hash: string; updated_at: string }>();
	if (!row) return null;
	let parsed: MachineCapabilities | null = null;
	try {
		parsed = parseMachineCapabilities(JSON.parse(row.raw_json));
	} catch {
		parsed = null;
	}
	return parsed ? { machineId, hash: row.capability_hash, updatedAt: row.updated_at, capabilities: parsed } : null;
}

/** The hash the platform holds, so the heartbeat can say "unchanged" without resending the record. */
export async function storedCapabilityHash(env: Db, userId: string, machineId: string): Promise<string | null> {
	if (!machineId) return null;
	const row = await env.DB.prepare("SELECT capability_hash FROM machine_capabilities WHERE machine_id = ?1 AND user_id = ?2").bind(machineId, userId).first<{ capability_hash: string }>();
	return row?.capability_hash ?? null;
}

export type UpsertResult = { stored: false; reason: string } | { stored: true; changed: boolean; hash: string; diff: string[] };

export async function upsertMachineCapabilities(env: Db, userId: string, machineId: string, raw: unknown): Promise<UpsertResult> {
	if (!machineId) return { stored: false, reason: "no machine id" };
	const caps = parseMachineCapabilities(raw);
	if (!caps) return { stored: false, reason: "not a capability record" };
	const hash = await capabilityHash(caps);
	const before = await getMachineCapabilities(env, userId, machineId);
	if (before?.hash === hash) {
		// Same facts: refresh when it was measured, record nothing.
		await env.DB.prepare("UPDATE machine_capabilities SET detected_at = ?3, updated_at = datetime('now') WHERE machine_id = ?1 AND user_id = ?2").bind(machineId, userId, caps.detectedAt).run();
		return { stored: true, changed: false, hash, diff: [] };
	}
	const diff = diffCapabilities(before?.capabilities ?? null, caps);
	const probes = caps.playwright.probes;
	await env.DB.prepare(
		`INSERT INTO machine_capabilities (machine_id, user_id, schema_version, detected_at, os_name, os_version, arch, cpu_count, memory_gb, disk_gb, playwright_version, browser_probe_results, ios_support, android_support, docker_support, node_version, runtime_inventory, capability_hash, raw_json, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, datetime('now'))
		 ON CONFLICT(machine_id) DO UPDATE SET user_id = excluded.user_id, schema_version = excluded.schema_version, detected_at = excluded.detected_at, os_name = excluded.os_name, os_version = excluded.os_version, arch = excluded.arch,
		   cpu_count = excluded.cpu_count, memory_gb = excluded.memory_gb, disk_gb = excluded.disk_gb, playwright_version = excluded.playwright_version, browser_probe_results = excluded.browser_probe_results,
		   ios_support = excluded.ios_support, android_support = excluded.android_support, docker_support = excluded.docker_support, node_version = excluded.node_version, runtime_inventory = excluded.runtime_inventory,
		   capability_hash = excluded.capability_hash, raw_json = excluded.raw_json, updated_at = datetime('now')
		 WHERE machine_capabilities.user_id = excluded.user_id`,
	)
		.bind(
			machineId, userId, caps.schemaVersion, caps.detectedAt, caps.os.name, caps.os.version, caps.os.arch, caps.cpuCount, caps.memoryGb, caps.diskGb, caps.playwright.version,
			JSON.stringify(probes), caps.ios ? 1 : 0, caps.android ? 1 : 0, caps.docker ? 1 : 0, caps.nodeVersion, JSON.stringify(caps.inventory), hash, JSON.stringify(caps),
		)
		.run();
	await env.DB.prepare("INSERT INTO machine_capability_history (machine_id, user_id, capability_hash, diff_json) VALUES (?1, ?2, ?3, ?4)").bind(machineId, userId, hash, JSON.stringify(diff)).run();
	await env.DB.prepare("DELETE FROM machine_capability_history WHERE machine_id = ?1 AND id NOT IN (SELECT id FROM machine_capability_history WHERE machine_id = ?1 ORDER BY id DESC LIMIT ?2)").bind(machineId, HISTORY_KEEP).run();
	return { stored: true, changed: true, hash, diff };
}

export async function capabilityHistory(env: Db, userId: string, machineId: string, limit = 20): Promise<Array<{ changedAt: string; hash: string; changes: string[] }>> {
	const { results } = await env.DB.prepare("SELECT changed_at, capability_hash, diff_json FROM machine_capability_history WHERE machine_id = ?1 AND user_id = ?2 ORDER BY id DESC LIMIT ?3").bind(machineId, userId, Math.min(Math.max(limit, 1), HISTORY_KEEP)).all<{ changed_at: string; capability_hash: string; diff_json: string }>();
	return (results ?? []).map((r) => {
		let changes: string[] = [];
		try {
			const d = JSON.parse(r.diff_json);
			changes = Array.isArray(d) ? d.filter((x): x is string => typeof x === "string") : [];
		} catch {
			// a corrupt row reads as "no detail", never an error
		}
		return { changedAt: r.changed_at, hash: r.capability_hash, changes };
	});
}

/** Bound on `needs`, so a requirement list cannot be used to make the gate do unbounded work. */
export const MAX_NEEDS = 20;

/** The fail-fast gate: refuse a job whose requirements this machine cannot meet, naming each one that fails. */
export async function checkJobCapabilityRequirements(env: Db, userId: string, machineId: string | null, needs: readonly string[]): Promise<{ ok: boolean; failures: string[] }> {
	const wanted = needs.map((n) => String(n).trim()).filter(Boolean).filter((_, i) => i < MAX_NEEDS);
	if (wanted.length === 0) return { ok: true, failures: [] };
	const stored = machineId ? await getMachineCapabilities(env, userId, machineId) : null;
	const r = checkCapabilityRequirements(stored?.capabilities ?? null, wanted);
	return { ok: r.satisfied, failures: r.failures.map((f) => (machineId ? `machine ${machineId.split("-")[0]}: ${f}` : f)) };
}

/** The read-back for lists and the console: facts and per-engine verdicts, not the raw record. */
export interface CapabilitySummary {
	os: string;
	arch: string;
	cpuCount: number | null;
	memoryGb: number | null;
	diskGb: number | null;
	nodeVersion: string | null;
	playwrightVersion: string | null;
	browsers: Record<BrowserEngine, { supported: boolean; probed: boolean; reason?: string }>;
	ios: boolean;
	android: boolean;
	docker: boolean;
	inventoryCount: number;
	reportedAt: string;
	hash: string;
}

export function summarizeCapabilities(stored: StoredCapabilities): CapabilitySummary {
	const c = stored.capabilities;
	const browsers = {} as CapabilitySummary["browsers"];
	for (const b of BROWSER_ENGINES) {
		const v = checkBrowserCompatibility(c, b);
		browsers[b] = { supported: v.supported, probed: c.playwright.probes.some((p) => p.browser === b), ...(v.reason ? { reason: v.reason } : {}) };
	}
	return { os: `${c.os.name} ${c.os.version}`.trim(), arch: c.os.arch, cpuCount: c.cpuCount, memoryGb: c.memoryGb, diskGb: c.diskGb, nodeVersion: c.nodeVersion, playwrightVersion: c.playwright.version, browsers, ios: c.ios, android: c.android, docker: c.docker, inventoryCount: c.inventory.length, reportedAt: stored.updatedAt, hash: stored.hash };
}

/** Every machine of the account that has reported, keyed by machine id. One query. */
export async function listCapabilitySummaries(env: Db, userId: string): Promise<Map<string, CapabilitySummary>> {
	const { results } = await env.DB.prepare("SELECT machine_id, raw_json, capability_hash, updated_at FROM machine_capabilities WHERE user_id = ?1").bind(userId).all<{ machine_id: string; raw_json: string; capability_hash: string; updated_at: string }>();
	const out = new Map<string, CapabilitySummary>();
	for (const r of results ?? []) {
		try {
			const capabilities = parseMachineCapabilities(JSON.parse(r.raw_json));
			if (capabilities) out.set(r.machine_id, summarizeCapabilities({ machineId: r.machine_id, hash: r.capability_hash, updatedAt: r.updated_at, capabilities }));
		} catch {
			// a corrupt row is a machine that has not reported
		}
	}
	return out;
}
