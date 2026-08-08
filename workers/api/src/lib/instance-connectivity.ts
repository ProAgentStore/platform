// The runtime facts a connectivity answer is built from — read once, for one instance or many.
//
// The I/O half of `subordinate-connectivity.ts` (#259) and of the coding driver's refusal (#271).
// Both need the same four facts and both must agree with what DELEGATION will actually do, so the
// live check here is `getBoundRunnerConn` — the exact resolver `callRunner`/`callRuntime` use.
// Deriving "online" any other way is how a status display ends up disagreeing with the thing it
// is describing: the DB `status` column is never cleared on disconnect (#238), so a machine whose
// laptop closed still reads `registered` forever.
import { getBoundRunnerConn, liveNodeIgnoringPin } from "./runner-client.js";
import { parseBoundRunnerNode } from "./runtime-nodes.js";
import type { Env } from "../types.js";

export interface RuntimeFacts {
	/** Any registration at all — the difference between "never ran `pags up`" and "it stopped". */
	hasRuntimeRow: boolean;
	/** A relay socket is live right now, on the node delegation would actually route to. */
	relayConnected: boolean;
	node: string | null;
	runnerVersion: string | null;
	lastSeenAt: string | null;
	/**
	 * The machine this instance is pinned to (`config.runnerNode`); null/"" = automatic.
	 *
	 * A connectivity record has no business knowing about instance config, and these two fields
	 * are the deliberate exception (#461). `diagnoseAttachment` cannot tell "pinned at a machine
	 * that is switched off while another one is up" from "the machine is up and only this agent
	 * lost its socket" without them — and the second diagnosis prescribes `pags up --force`,
	 * which cannot repoint a pin. `describeFacts(facts)` is the ONLY path three surfaces reach
	 * that diagnosis by, so a fact absent here is a wrong sentence there. Two named fields, not a
	 * general "everything about this instance" record.
	 */
	pinnedNode?: string | null;
	/**
	 * A machine holding a live socket for this instance which the PIN excludes.
	 *
	 * DESCRIPTION ONLY, never a routing destination — taking it as one is exactly the fallback
	 * `getBoundRunnerConn` forbids (#379/#380). It is what lets the sentence name the machine that
	 * IS up instead of telling the user to start a runner they are already running.
	 */
	liveNodeExcludedByPin?: string | null;
}

const EMPTY: RuntimeFacts = {
	hasRuntimeRow: false,
	relayConnected: false,
	node: null,
	runnerVersion: null,
	lastSeenAt: null,
	pinnedNode: null,
	liveNodeExcludedByPin: null,
};

/**
 * How many instances we will probe the relay for in one call.
 *
 * Each probe is a Durable Object fetch, so this is the only unbounded cost in
 * `subordinate_status`. A supervisor with more subordinates than this still gets rows — they
 * report `hasRuntimeRow` from the batched SQL and an unknown socket — which degrades to the old
 * behaviour for the tail rather than timing out the whole tool.
 */
export const MAX_RELAY_PROBES = 16;

interface RegistrationRow {
	instance_id: string;
	runner_node: string | null;
	runner_version: string | null;
	last_seen_at: string | null;
}

/** Registrations for a set of instances, in ONE statement regardless of fan-out. */
async function registrations(env: Env, userId: string, ids: readonly string[]): Promise<Map<string, RegistrationRow>> {
	const out = new Map<string, RegistrationRow>();
	if (!ids.length) return out;
	// `?1` is the user; the ids are bound TWICE (once per half of the union) because D1 numbers
	// placeholders positionally — reusing ?2..?n in both halves would silently read the wrong slots.
	const ph1 = ids.map((_, i) => `?${i + 2}`).join(",");
	const ph2 = ids.map((_, i) => `?${i + 2 + ids.length}`).join(",");
	// Both tables: `instance_runtimes` is the legacy default row (still the only one a
	// single-machine account writes) and `instance_runtime_nodes` is the per-machine registration
	// multi-machine routing uses. Reading only one of them under-reports whole accounts.
	const sql = `SELECT instance_id, runner_node, runner_version, last_seen_at FROM instance_runtimes WHERE user_id = ?1 AND instance_id IN (${ph1})
	             UNION ALL
	             SELECT instance_id, runner_node, runner_version, last_seen_at FROM instance_runtime_nodes WHERE user_id = ?1 AND instance_id IN (${ph2})`;
	const res = await env.DB.prepare(sql)
		.bind(userId, ...ids, ...ids)
		.all<RegistrationRow>()
		.catch(() => ({ results: [] as RegistrationRow[] }));
	const at = (s: string | null | undefined) => (s ? Date.parse(`${s.replace(" ", "T")}Z`) || 0 : 0);
	for (const r of res.results ?? []) {
		const prev = out.get(r.instance_id);
		// Freshest heartbeat wins. On a multi-machine account the stale default row and a live
		// node row both match; picking the older one would diagnose "runner-offline" for a
		// machine that is heartbeating right now.
		if (!prev || at(r.last_seen_at) > at(prev.last_seen_at)) out.set(r.instance_id, r);
	}
	return out;
}

/**
 * The "Runs on" pin for a whole set of instances, in ONE statement (#461).
 *
 * Batched deliberately: this function is the read behind `subordinate_status`, so a per-instance
 * config lookup would multiply the fan-out it exists to bound. `getBoundRunnerConn` already reads
 * the same column while routing, but it returns a connection rather than the reason there isn't
 * one, and the reason is the whole point here.
 */
async function pinnedNodes(env: Env, userId: string, ids: readonly string[]): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	if (!ids.length) return out;
	const ph = ids.map((_, i) => `?${i + 2}`).join(",");
	const res = await env.DB.prepare(`SELECT id, config FROM agent_instances WHERE user_id = ?1 AND id IN (${ph})`)
		.bind(userId, ...ids)
		.all<{ id: string; config: string | null }>()
		.catch(() => ({ results: [] as { id: string; config: string | null }[] }));
	for (const r of res.results ?? []) {
		const node = parseBoundRunnerNode(r.config);
		if (node) out.set(r.id, node);
	}
	return out;
}

export async function runtimeConnectivityMany(env: Env, userId: string, ids: readonly string[]): Promise<Map<string, RuntimeFacts>> {
	const [rows, pins] = await Promise.all([registrations(env, userId, ids), pinnedNodes(env, userId, ids)]);
	const out = new Map<string, RuntimeFacts>();
	const probe = ids.slice(0, MAX_RELAY_PROBES);
	const live = await Promise.all(probe.map((id) => getBoundRunnerConn(env, id, userId).catch(() => null)));
	// Which machine is up INSTEAD — asked only where it can change the answer: a pin exists AND
	// nothing resolved. A live socket or an unpinned instance pays nothing, and the whole set is
	// resolved in parallel under the same MAX_RELAY_PROBES bound as the probe above.
	const excluded = await Promise.all(
		probe.map((id, i) => (pins.get(id) && !live[i] ? liveNodeIgnoringPin(env, id, userId).catch(() => null) : Promise.resolve(null))),
	);
	for (const [i, id] of probe.entries()) {
		const row = rows.get(id);
		const conn = live[i];
		out.set(id, {
			hasRuntimeRow: Boolean(row),
			relayConnected: Boolean(conn),
			// Prefer the node the LIVE socket is on — that is where work would actually run, and
			// naming any other machine in a remedy sends the user to the wrong laptop.
			node: (conn?.runnerNode || row?.runner_node || "").trim() || null,
			runnerVersion: (row?.runner_version || "").trim() || null,
			lastSeenAt: row?.last_seen_at ?? null,
			pinnedNode: pins.get(id) ?? null,
			liveNodeExcludedByPin: excluded[i],
		});
	}
	for (const id of ids.slice(MAX_RELAY_PROBES)) {
		const row = rows.get(id);
		// The tail carries the pin (it came from the batched read and costs nothing) but NOT the
		// machine that is up instead, because nothing probed for one. `diagnoseAttachment` needs
		// both, so the tail degrades to exactly its previous answer rather than to a half-diagnosis.
		out.set(id, {
			...EMPTY,
			hasRuntimeRow: Boolean(row),
			node: (row?.runner_node || "").trim() || null,
			lastSeenAt: row?.last_seen_at ?? null,
			pinnedNode: pins.get(id) ?? null,
		});
	}
	return out;
}

/**
 * One instance. Argument order matches every other single-instance runner helper
 * (`getRunnerConn`, `getBoundRunnerConn`, `relayConnected`) — `(env, instanceId, userId)` — while
 * the batch form above matches its neighbours (`recentWorkForInstances(env, userId, ids)`). Two
 * same-typed strings in either order silently typecheck, so following the local convention is the
 * only thing keeping a call site honest.
 */
export async function runtimeConnectivity(env: Env, instanceId: string, userId: string): Promise<RuntimeFacts> {
	const m = await runtimeConnectivityMany(env, userId, [instanceId]);
	return m.get(instanceId) ?? EMPTY;
}
