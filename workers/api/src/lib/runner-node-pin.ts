/**
 * The "Runs on" pin — `agent_instances.config.runnerNode` — and the record of every change to it
 * (#533).
 *
 * ── Why this key gets a module of its own ──
 *
 * The pin is authoritative for routing: `getBoundRunnerConn` (`lib/runner-client.ts`) resolves the
 * pinned machine and never falls through to another one. So this single config key decides whether
 * an instance can reach ANY runner — every chat tool call, every apply step, every coding session.
 *
 * It was written by a route that logged nothing. `routes/instances.ts` had no event write at all,
 * so a change to the most consequential routing input on the platform left no trace anywhere: no
 * `agent_events` row, no activity entry, no error-log entry.
 *
 * That already cost a diagnosis. On 2026-08-12 the owner asked why an agent reported "runner
 * offline" while the picker showed the node online; #530 and #531 shipped the mechanism and the
 * remedies, but the investigation's central claim — that the pin held `Sergeys-Mac-mini.local` at
 * 07:44:10 — had to be filed as INFERRED rather than measured, because the repin left nothing
 * behind. A platform that cannot say when its own routing changed cannot fully diagnose a routing
 * failure.
 *
 * ── Why the write lives here and not in the route, nor in `instance-config.ts` ──
 *
 * In the route, the audit would be something each caller remembers. There is one caller today
 * (`PUT /v1/instances/:id/runner-node`); an MCP tool or a CLI command that repins later would
 * silently reproduce exactly the gap this module closes. `noOtherWriterOfThePin` in the test file
 * makes that impossible to do by accident — the same guard shape `instance-config.test.ts` uses to
 * keep whole-blob config writes out (#231).
 *
 * In `instance-config.ts`, it would be a per-key branch inside a GENERIC primitive: that module
 * patches any of a dozen keys and knows nothing about what they mean. Auditing every key there
 * would bury the routing change among behaviour and translation edits; auditing one key there
 * would be `if (key === "runnerNode")` in the middle of a store helper. And the pin's READ side
 * (`parseBoundRunnerNode`, `readInstanceRunnerNode`) lives in `runtime-nodes.ts`, which cannot host
 * the write either: `instance-config.ts` imports it, so calling back the other way is an import
 * cycle. A small module that owns the pin end to end is the placement with no such compromise.
 *
 * ── The read this adds, which is not the read #350 removed ──
 *
 * The route previously carried a `SELECT config` whose result nothing looked at — dead weight left
 * by the #231 refactor, deleted by #350. This one IS looked at: its value is the `from` field of
 * the record. Without reading the old pin first there is no "previous value" to write down, which
 * is acceptance criterion 1.
 *
 * It is a read-then-write, not a transaction: two concurrent repins can both observe the same
 * `from`. That is the same last-write-wins `patchInstanceConfig` already documents for one key, and
 * the honest reading of the record is "this request replaced the value it observed", not "the
 * platform serialised these two writes".
 */
import { logEvent } from "./events.js";
import { patchInstanceConfig, removeInstanceConfigKey } from "./instance-config.js";
import { normalizeRunnerNode, readInstanceRunnerNode } from "./runtime-nodes.js";
import type { Env } from "../types.js";

/** The trace `source` for the machine-placement plane (`instance_runtime_nodes`, `/runtime/status`). */
export const RUNNER_PIN_EVENT_SOURCE = "runtime";
/** One name for both directions: pinning and clearing are the same fact — routing changed. */
export const RUNNER_PIN_EVENT = "runner_node.changed";

/** How an unset pin reads in the record. Not "" or "none": the picker calls this state Automatic. */
const AUTOMATIC = "automatic";

export interface RunnerNodePinChange {
	/** The pin as observed before this call. `""` = automatic. */
	from: string;
	/** The pin after this call. `""` = automatic. */
	to: string;
	/** Did routing actually move? False for a no-op repin, and false when no row matched. */
	changed: boolean;
}

/** The one-line summary an investigator reads in the trace. Pure, so the wording is testable. */
export function describePinChange(from: string, to: string): string {
	return `Runs on: ${from || AUTOMATIC} → ${to || AUTOMATIC}`;
}

/**
 * Set (or clear, with an empty value) the machine this instance is pinned to, recording the change.
 *
 * Returns what the pin was and what it became, so the caller can answer without re-reading.
 *
 * A NO-OP WRITES NOTHING TO THE TRACE — deliberately (acceptance criterion 3). The record answers
 * "when did routing change, and from what to what"; a row whose `from` equals its `to` answers
 * nothing and would outnumber the real changes, because re-selecting the machine already chosen is
 * a normal thing to do in a picker. The config UPDATE still runs in that case, so `updated_at`
 * behaves exactly as it did before this module existed — only the event is suppressed.
 *
 * The DB write returning `true` means "a row matched and was updated", NOT "the value differed":
 * `json_remove` of an absent key still updates the row. `changed` is therefore decided by comparing
 * the values, and gated on the write having landed, so the trace never claims a change that the
 * database refused (a non-owner, a deleted instance).
 */
export async function setRunnerNodePin(
	env: Env,
	instanceId: string,
	userId: string,
	requested: unknown,
	opts: { via?: string } = {},
): Promise<RunnerNodePinChange> {
	const to = normalizeRunnerNode(requested);
	const from = await readInstanceRunnerNode(env, instanceId, userId);
	// Patch just this key (#231) — pinning a runner must not clobber a Settings or behaviour change
	// saved from another tab between the read and the write.
	const written = to
		? await patchInstanceConfig(env, instanceId, userId, "runnerNode", to)
		: await removeInstanceConfigKey(env, instanceId, userId, "runnerNode");
	const changed = written && to !== from;
	if (changed) {
		await logEvent(env, {
			source: RUNNER_PIN_EVENT_SOURCE,
			event: RUNNER_PIN_EVENT,
			level: "info",
			// WHO and WHEN — the two fields whose absence made #530's claim an inference. `user_id`
			// is the account that made the change (an instance has exactly one owner); `ts` defaults
			// to now, which is the moment routing moved.
			userId,
			instanceId,
			message: describePinChange(from, to),
			context: {
				// null rather than "" for automatic: a reader scanning JSON should not have to know
				// that an empty string is a meaningful state here.
				from: from || null,
				to: to || null,
				/** Which surface repinned. One writer today; the guard test keeps it that way. */
				via: opts.via || "api",
			},
		});
	}
	return { from, to, changed };
}
