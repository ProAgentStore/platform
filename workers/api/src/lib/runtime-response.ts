// How a runtime registration is presented to a caller — the default row, and one machine's row.
//
// Split out of `routes/instances-runtime.ts` (#570). These are pure functions of a D1 row with no
// Hono, no env and no I/O, and the file they lived in is a 900-line route module under a size
// ratchet. Re-exported from there, so every existing importer is unchanged.
import { heartbeatFresh } from "./runtime-attachment.js";
import { relayNameForInstance, type RuntimeRow } from "./runtime-nodes.js";

/**
 * `now` in the shape D1 stores it: `YYYY-MM-DD HH:MM:SS`, no zone.
 *
 * Not cosmetic. `heartbeatFresh` parses a stored stamp as `` `${s.replace(" ", "T")}Z` `` — so an
 * ISO-8601 string, which already ends in `Z`, becomes `…ZZ`, `Date.parse` returns NaN, and the row
 * reads as NEVER HEARD FROM. The `/runtime/status` probe built its echoed row with
 * `new Date().toISOString()`; that was harmless while the status was published raw and became a
 * live defect the moment the status was derived from it (#587): the probe reported `offline` for a
 * machine it had just successfully reached. Found in production, not in the suite, because every
 * test fixture was already written in the D1 shape.
 *
 * Any code putting a synthesised timestamp into a `RuntimeRow` uses this.
 */
export function d1Timestamp(at: Date = new Date()): string {
	return at.toISOString().replace("T", " ").slice(0, 19);
}

export function safeParseArray(value: string): unknown[] {
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * A runtime registration, with `status` derived from its HEARTBEAT rather than read off the
 * column — for the default row exactly as for a node row (#587).
 *
 * This is the ONE serialiser. It was not, and that is the whole bug: #570 put the derivation in
 * `runtimeNodeResponse` and left this function publishing `row.status` raw, so `nodes[]` told the
 * truth and the `runtime` field beside it in the SAME response did not. Measured 2026-08-15:
 * `runtime.status === "online"` on 22 of 22 instances, including two naming a machine last seen
 * 10h36m earlier. A derivation that lives in one of two serialisers is a derivation with a
 * bypass, so it lives here, where every publisher of a runtime row already goes.
 *
 * A stored `offline` still wins, so the derivation can only ever move the answer TOWARD offline
 * — a future writer that marks a runtime down is not undone here.
 */
export function runtimeResponse(row: RuntimeRow) {
	const fresh = heartbeatFresh(row.last_seen_at);
	return {
		instanceId: row.instance_id,
		placement: row.placement,
		endpointUrl: row.endpoint_url,
		capabilities: safeParseArray(row.capabilities),
		runnerVersion: row.runner_version,
		runnerNode: row.runner_node || "",
		status: row.status === "offline" || !fresh ? "offline" : row.status,
		lastSeenAt: row.last_seen_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		hasToken: Boolean(row.token_plaintext || row.token_ciphertext),
	};
}

/**
 * One machine's registration: the same derived view, plus the relay name that only a per-node row
 * has (#570).
 *
 * `instance_runtime_nodes.status` had no writer for any value but `"online"`: of eight
 * `updateRuntimeStatus` call sites exactly one passed a node, and it passed `"online"` at
 * registration — every `offline` write reached `instance_runtimes` and never the per-node table.
 * This function published that write-once column, so one instance reported four machines `online`
 * with three of them last seen 2-4 days earlier. That is the answer `instance_runtime_status`
 * gives over MCP and `pags runner status` prints. (#587 gave the node table its `offline` writer
 * as well, by passing the node from the probe path — the derivation is the second line of defence,
 * not the only one.)
 *
 * Routing never trusted the column (`getBoundRunnerConn` is live-checked; `instance-connectivity.ts`
 * states why), which is exactly why this stayed invisible — its only consumer was the surface used
 * to debug the others.
 *
 * Deliberately NOT a per-node relay probe: this is a serialiser, and making it async would put a
 * Durable Object fetch per node behind a list endpoint. `?probe=1` (`/runtime/status`) is where the
 * live check belongs and already is.
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
	return {
		...runtimeResponse(row),
		relayName: relayNameForInstance(row.instance_id, row.runner_node),
	};
}
