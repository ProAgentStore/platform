/**
 * Which of the owner's machines could run this instance's browser verification right now (#1031).
 *
 * Eligibility is four separate facts, never one inferred from another (#1032):
 *   - capability — the agent declares a local browser (checked by the caller);
 *   - attachment — the relay holds THIS instance's socket on the machine (transport only);
 *   - health     — the runner behind that socket answers `/health`;
 *   - version    — its CLI can drive the configured engine (`engineRunnerProblem`).
 * A machine is eligible only when all hold. The candidates are the owner's machines, folded by
 * machine id, this instance's own first (`pinCandidates`, #1037).
 */
import { engineRunnerProblem } from "./local-browser/start.js";
import { freshestVersion, namesOfMachine, normalizeMachineId, pinCandidates } from "./machine-identity.js";
import { relayConnected } from "./runner-client.js";
import type { PostAttachHealth } from "./runner-health.js";
import { healthAfterAttach } from "./runner-repin.js";
import { heartbeatFresh } from "./runtime-attachment.js";
import { normalizeRunnerNode } from "./runtime-nodes.js";
import type { Env } from "../types.js";

/** Probes are live relay calls; an account with more machines than this lists the rest unprobed. */
const MAX_PROBED = 10;
const HEALTH_BUDGET_MS = 5_000;

export type RuntimeIneligibility = "not_attached" | "unhealthy" | "runner_too_old" | "not_probed";

export interface BrowserRuntimeCandidate {
	node: string;
	/** Other names the same machine answers to. */
	aka?: string[];
	pinned: boolean;
	heartbeat: { lastSeenAt: string | null; fresh: boolean };
	/** The relay holds this instance's socket there — transport only. */
	attached: boolean;
	health: PostAttachHealth;
	runnerVersion: string | null;
	eligible: boolean;
	/** Why not, when not eligible. */
	reason?: RuntimeIneligibility;
	detail?: string;
}

interface Row {
	instance_id: string;
	runner_node: string;
	machine_id: string | null;
	runner_version: string | null;
	last_seen_at: string | null;
}

export async function browserRuntimeCandidates(env: Env, instanceId: string, uid: string, opts: { engine: string; pinnedNode: string | null }): Promise<BrowserRuntimeCandidate[]> {
	const rows = ((await env.DB.prepare(
		"SELECT instance_id, runner_node, machine_id, runner_version, last_seen_at FROM instance_runtime_nodes WHERE user_id = ?1 AND runner_node IS NOT NULL AND runner_node != '' ORDER BY updated_at DESC",
	)
		.bind(uid)
		.all<Row>()).results ?? []);
	const registrations = rows.map((r) => ({ node: r.runner_node, machineId: r.machine_id, instanceId: r.instance_id, lastSeenAt: r.last_seen_at, version: r.runner_version }));
	const reg = (r: Row) => ({ node: normalizeRunnerNode(r.runner_node), machineId: r.machine_id, lastSeenAt: r.last_seen_at });
	const machines = pinCandidates(rows.filter((r) => r.instance_id === instanceId).map(reg), rows.map(reg)).filter((m) => m.node);
	const pinned = opts.pinnedNode ? normalizeRunnerNode(opts.pinnedNode) : "";
	// The pinned machine is probed first, so the cap never drops the one the setting may name.
	machines.sort((a, b) => Number(namesOfMachine(b.node, registrations).includes(pinned)) - Number(namesOfMachine(a.node, registrations).includes(pinned)));

	const out: BrowserRuntimeCandidate[] = [];
	for (const [i, m] of machines.entries()) {
		const names = namesOfMachine(m.node, registrations);
		const freshest = rows
			.filter((r) => names.includes(normalizeRunnerNode(r.runner_node)) || (normalizeMachineId(r.machine_id) && normalizeMachineId(r.machine_id) === normalizeMachineId(m.machineId)))
			.map((r) => r.last_seen_at)
			.filter((s): s is string => !!s)
			.sort()
			.pop() ?? null;
		const version = freshestVersion(names, registrations) ?? null;
		const base = {
			node: m.node,
			...(names.length > 1 ? { aka: names.slice(1) } : {}),
			pinned: !!pinned && names.includes(pinned),
			heartbeat: { lastSeenAt: freshest, fresh: heartbeatFresh(freshest) },
			runnerVersion: version,
		};
		if (i >= MAX_PROBED) {
			out.push({ ...base, attached: false, health: { state: "not_attempted" }, eligible: false, reason: "not_probed", detail: `Not checked: only the first ${MAX_PROBED} machines are probed.` });
			continue;
		}
		let attached = false;
		for (const n of names) if (await relayConnected(env, instanceId, n).catch(() => false)) attached = true;
		if (!attached) {
			out.push({ ...base, attached, health: { state: "not_attempted" }, eligible: false, reason: "not_attached", detail: `This agent holds no relay socket on ${m.node}. Pin it there (set_instance_runner_node) or attach it (force_runner_attach).` });
			continue;
		}
		const health = await healthAfterAttach(env, instanceId, uid, names, HEALTH_BUDGET_MS);
		if (health.state !== "ok") {
			out.push({ ...base, attached, health, eligible: false, reason: "unhealthy", detail: `Attached on ${m.node}, but the runner did not pass its health check (${health.state}). runner_restart restarts it.` });
			continue;
		}
		const tooOld = engineRunnerProblem(opts.engine, version, m.node);
		out.push(tooOld ? { ...base, attached, health, eligible: false, reason: "runner_too_old", detail: tooOld } : { ...base, attached, health, eligible: true });
	}
	return out;
}

/**
 * The machine a verification would run on under the instance's `runtime` setting — or null, which
 * is what the fallback policy (`wait` / `mark_unverifiable`) is for.
 */
export function selectBrowserRuntime(candidates: readonly BrowserRuntimeCandidate[], runtime: "pinned" | "any_eligible"): BrowserRuntimeCandidate | null {
	const pinned = candidates.find((c) => c.pinned);
	if (runtime === "pinned") return pinned?.eligible ? pinned : null;
	return pinned?.eligible ? pinned : (candidates.find((c) => c.eligible) ?? null);
}
