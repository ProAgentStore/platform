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
import { HttpError } from "./auth.js";
import { logEvent } from "./events.js";
import { instanceListName, patchInstanceConfig, removeInstanceConfigKey } from "./instance-config.js";
import { adoptableIdByName, identityHint, type NodeRegistration } from "./machine-identity.js";
import { machineDisplayNames, machineIdForDisplayName } from "./machine-names.js";
import { normalizeMachineId, normalizeRunnerNode, parseRunnerPin, resolveRunnerPin } from "./runtime-nodes.js";
import type { Env } from "../types.js";

/** The trace `source` for the machine-placement plane (`instance_runtime_nodes`, `/runtime/status`). */
export const RUNNER_PIN_EVENT_SOURCE = "runtime";
/** One name for both directions: pinning and clearing are the same fact — routing changed. */
export const RUNNER_PIN_EVENT = "runner_node.changed";

/** How an unset pin reads in the record. Not "" or "none": the picker calls this state Automatic. */
const AUTOMATIC = "automatic";

export interface RunnerNodePinChange {
	/** The pin as observed before this call, as a label (`name (machine id)`, or a legacy hostname). `""` = automatic. */
	from: string;
	/** The hostname the pinned machine answers to now — what routing and attaching use. `""` = automatic. */
	to: string;
	/** The machine id now pinned (#1250). `""` = automatic. */
	machineId: string;
	/** The owner's name for that machine, when it has one. */
	displayName: string | null;
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
/**
 * The machine a requested pin names (#1250): an owner-set display name, a machine id, or a hostname
 * that resolves to exactly ONE machine id. A pin is a machine id, never a hostname — so a hostname with
 * no id behind it, with two, or with no registration at all is refused with the reason, not stored.
 */
export async function resolvePinTarget(env: Pick<Env, "DB">, userId: string, requested: string): Promise<string> {
	const byName = await machineIdForDisplayName(env, userId, requested);
	if (byName) return byName;
	const asId = normalizeMachineId(requested);
	if (asId) {
		const known = await env.DB.prepare("SELECT 1 AS hit FROM instance_runtime_nodes WHERE user_id = ?1 AND machine_id = ?2 LIMIT 1").bind(userId, asId).first();
		if (known) return asId;
	}
	const { results } = await env.DB.prepare("SELECT machine_id, runner_version FROM instance_runtime_nodes WHERE user_id = ?1 AND runner_node = ?2")
		.bind(userId, requested)
		.all<{ machine_id: string | null; runner_version: string | null }>();
	const rows = results ?? [];
	const ids = [...new Set(rows.map((r) => normalizeMachineId(r.machine_id)).filter(Boolean))];
	if (ids.length === 1) return ids[0];
	if (ids.length > 1) throw new HttpError(409, `"${requested}" has been used by ${ids.length} different machines (${ids.join(", ")}), so it does not name one. Pin by display name or machine id.`);
	if (rows.length) {
		const hint = identityHint(null, rows[0]?.runner_version ?? null);
		throw new HttpError(409, `The machine registered as "${requested}" has no stable machine id, and a pin must name a machine, not a hostname that can change.${hint ? ` ${hint}` : ""}`);
	}
	throw new HttpError(404, `No machine of yours is called "${requested}" — not a display name, a machine id or a hostname any of them registered under. list_runner_nodes names them.`);
}

/** How a pin reads in the record: `name (id)`, the bare id, or a legacy hostname. */
async function pinLabel(env: Pick<Env, "DB">, userId: string, machineId: string, legacyNode: string): Promise<string> {
	if (!machineId) return legacyNode;
	const name = (await machineDisplayNames(env, userId)).get(machineId);
	return name ? `${name} (${machineId})` : machineId;
}

export async function setRunnerNodePin(
	env: Env,
	instanceId: string,
	userId: string,
	requested: unknown,
	opts: { via?: string } = {},
): Promise<RunnerNodePinChange> {
	const asked = normalizeRunnerNode(requested);
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, userId).first<{ config: string | null }>();
	const before = await resolveRunnerPin(env, userId, row?.config);
	const fromLabel = await pinLabel(env, userId, before.machineId, before.legacyNode);
	const machineId = asked ? await resolvePinTarget(env, userId, asked) : "";
	// The id first, then the legacy hostname key goes (#1250): a reader never sees a moment with
	// neither, and `parseRunnerPin` already prefers the id while both are present. Each is a
	// single-key patch (#231) so a Settings change saved in between is not clobbered.
	const written = machineId
		? await patchInstanceConfig(env, instanceId, userId, "runnerMachineId", machineId)
		: await removeInstanceConfigKey(env, instanceId, userId, "runnerMachineId");
	if (written) await removeInstanceConfigKey(env, instanceId, userId, "runnerNode");
	const after = machineId ? await resolveRunnerPin(env, userId, JSON.stringify({ runnerMachineId: machineId })) : { node: "", machineId: "", legacyNode: "" };
	const to = after.node;
	const toLabel = await pinLabel(env, userId, machineId, "");
	const displayName = machineId ? ((await machineDisplayNames(env, userId)).get(machineId) ?? null) : null;
	const changed = written && toLabel !== fromLabel;
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
			message: describePinChange(fromLabel, toLabel),
			context: {
				// null rather than "" for automatic: a reader scanning JSON should not have to know
				// that an empty string is a meaningful state here.
				from: fromLabel || null,
				to: toLabel || null,
				machineId: machineId || null,
				/** Which surface repinned. One writer today; the guard test keeps it that way. */
				via: opts.via || "api",
			},
		});
	}
	return { from: fromLabel, to, machineId, displayName, changed };
}

/**
 * Instances still pinned by a pre-#1250 HOSTNAME: migration 0262 could not tie the name to one machine
 * id. Each still routes by that hostname, so it breaks the next time the machine renames itself;
 * `machineId` says which machine the name would resolve to now, when it can be told.
 */
export async function unresolvedPins(env: Pick<Env, "DB">, userId: string, registrations: readonly NodeRegistration[]): Promise<Array<{ instanceId: string; name: string; pinnedHostname: string; machineId: string | null; reason: string }>> {
	const { results } = await env.DB.prepare(
		`SELECT i.id, i.config, a.name AS agent_name, a.slug AS agent_slug FROM agent_instances i LEFT JOIN agents a ON a.id = i.agent_id
		 WHERE i.user_id = ?1 AND json_valid(i.config) AND json_extract(i.config, '$.runnerNode') IS NOT NULL AND json_extract(i.config, '$.runnerMachineId') IS NULL`,
	)
		.bind(userId)
		.all<{ id: string; config: string | null; agent_name: string | null; agent_slug: string | null }>();
	const idByName = adoptableIdByName(registrations);
	const known = new Set(registrations.map((r) => normalizeRunnerNode(r.node)));
	return (results ?? []).flatMap((i) => {
		const host = parseRunnerPin(i.config).legacyNode;
		if (!host) return [];
		const machineId = idByName.get(host) ?? null;
		const reason = machineId
			? "this hostname now resolves to one machine — re-pin by display name or machine id"
			: known.has(host)
				? "no machine id was ever registered under this hostname (a CLI older than 0.4.40), or two machines used it"
				: "no machine has registered under this hostname";
		return [{ instanceId: i.id, name: instanceListName(i.config, i.agent_name ?? i.agent_slug) ?? "Agent", pinnedHostname: host, machineId, reason }];
	});
}
