// How a runtime registration is presented to a caller — the default row, and one machine's row.
//
// Split out of `routes/instances-runtime.ts` (#570). These are pure functions of a D1 row with no
// Hono, no env and no I/O, and the file they lived in is a 900-line route module under a size
// ratchet. Re-exported from there, so every existing importer is unchanged.
import { heartbeatFresh } from "./runtime-attachment.js";
import { relayNameForInstance, type RuntimeRow } from "./runtime-nodes.js";

export function safeParseArray(value: string): unknown[] {
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export function runtimeResponse(row: RuntimeRow) {
	return {
		instanceId: row.instance_id,
		placement: row.placement,
		endpointUrl: row.endpoint_url,
		capabilities: safeParseArray(row.capabilities),
		runnerVersion: row.runner_version,
		runnerNode: row.runner_node || "",
		status: row.status,
		lastSeenAt: row.last_seen_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		hasToken: Boolean(row.token_plaintext || row.token_ciphertext),
	};
}

/**
 * One machine's registration, with a status derived from its HEARTBEAT rather than read off the
 * column (#570).
 *
 * `instance_runtime_nodes.status` has no writer for any value but `"online"`: of eight
 * `updateRuntimeStatus` call sites exactly one passes a node, and it passes `"online"` at
 * registration — every `offline` write reaches `instance_runtimes` and never the per-node table.
 * This function published that write-once column, so one instance reported four machines `online`
 * with three of them last seen 2-4 days earlier. That is the answer `instance_runtime_status`
 * gives over MCP and `pags runner status` prints.
 *
 * Routing never trusted the column (`getBoundRunnerConn` is live-checked; `instance-connectivity.ts`
 * states why), which is exactly why this stayed invisible — its only consumer was the surface used
 * to debug the others.
 *
 * Deliberately NOT a per-node relay probe: this is a serialiser, and making it async would put a
 * Durable Object fetch per node behind a list endpoint. `?probe=1` (`/runtime/status`) is where the
 * live check belongs and already is. A stored `offline` still wins, so the derivation can only ever
 * move the answer toward offline — a future writer that marks a node down is not undone here.
 *
 * ## Exactly one parameter, deliberately
 *
 * The first cut of this took `(row, now = Date.now())` so a test could pin the clock. Both callers
 * are `nodes.map(runtimeNodeResponse)`, and `Array.prototype.map` passes `(element, index, array)`
 * — so `now` received 0, 1, 2, 3. `0 - <a real timestamp>` is hugely negative, which is less than
 * the window, so EVERY node read fresh and the fix did nothing in production while its unit tests
 * (which passed `now` explicitly) stayed green. Tests move the clock with `vi.setSystemTime`
 * instead; a one-argument function cannot be corrupted by the extra arguments `map` supplies.
 */
export function runtimeNodeResponse(row: RuntimeRow) {
	const base = runtimeResponse(row);
	const fresh = heartbeatFresh(row.last_seen_at);
	return {
		...base,
		status: base.status === "offline" || !fresh ? "offline" : base.status,
		relayName: relayNameForInstance(row.instance_id, row.runner_node),
	};
}
