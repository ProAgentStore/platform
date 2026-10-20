/**
 * One row of `instance_runtimes` (the legacy default registration) or of
 * `instance_runtime_nodes` (one per machine). Both tables carry the same columns, which is why one
 * type serves both.
 *
 * Lives here rather than in the route module so that `lib/runtime-response.ts` — the serialiser
 * split out of it — can name its own input without importing a routes module back. That edge was a
 * static import cycle, and `import-graph.test.ts` failed on it.
 */
export interface RuntimeRow {
	instance_id: string;
	user_id: string;
	placement: string;
	endpoint_url: string;
	token_ciphertext: ArrayBuffer | Uint8Array | null;
	token_dek_wrapped: ArrayBuffer | Uint8Array | null;
	token_iv: ArrayBuffer | Uint8Array | null;
	token_plaintext: string | null;
	capabilities: string;
	runner_version: string;
	runner_node: string;
	/** Stable machine identity (#379). Only on `instance_runtime_nodes`, and null until the
	 *  machine has registered with a CLI that mints one. */
	machine_id?: string | null;
	/** The machine's last resource sample, JSON (#924). Only on `instance_runtime_nodes`; null from a CLI before 0.4.71. */
	resources?: string | null;
	status: string;
	last_seen_at: string | null;
	created_at: string;
	updated_at: string;
}

export function normalizeRunnerNode(value: unknown): string {
	return String(value || "").trim().slice(0, 120);
}

export function relayNameForInstance(instanceId: string, runnerNode?: string | null): string {
	const node = normalizeRunnerNode(runnerNode);
	return node ? `${instanceId}:node:${node}` : instanceId;
}

/**
 * A machine id is opaque to the server — it only ever compares two of them — so the only rules
 * are length and a character set that cannot smuggle anything into a log or a query.
 */
export function normalizeMachineId(value: unknown): string {
	const raw = String(value ?? "").trim();
	return /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw : "";
}

/**
 * The "Runs on" pin as stored (#1250): the machine's stable id (`config.runnerMachineId`), or — for a
 * pin set before #1250 that the migration could not resolve — the hostname it was set under
 * (`config.runnerNode`). The id wins when both are present: the hostname is then a leftover the next
 * write removes, never the pin.
 */
export interface RunnerPin {
	machineId: string;
	legacyNode: string;
}

export function parseRunnerPin(configJson: string | null | undefined): RunnerPin {
	try {
		const cfg = JSON.parse(configJson || "{}") as { runnerNode?: unknown; runnerMachineId?: unknown };
		const machineId = normalizeMachineId(cfg.runnerMachineId);
		return { machineId, legacyNode: machineId ? "" : normalizeRunnerNode(cfg.runnerNode) };
	} catch {
		return { machineId: "", legacyNode: "" };
	}
}

/** One registration, reduced to what resolving a pin needs. */
export interface PinNodeRow {
	runner_node: string;
	machine_id?: string | null;
	last_seen_at?: string | null;
}

/**
 * The hostname a pinned machine answers to NOW — its most recently seen registration (#1250). A
 * hostname change is a fresher row under the same id, so the pin follows the machine. A machine with
 * no registration left resolves to its id itself, which names no relay and no row: the pin then reads
 * offline, never "automatic" — routing must not fall through to another machine.
 */
export function pinnedNodeName(pin: RunnerPin, rows: readonly PinNodeRow[]): string {
	if (!pin.machineId) return pin.legacyNode;
	let best: { node: string; at: number } | null = null;
	for (const r of rows) {
		if (normalizeMachineId(r.machine_id) !== pin.machineId) continue;
		const node = normalizeRunnerNode(r.runner_node);
		const at = r.last_seen_at ? Date.parse(r.last_seen_at.includes("T") ? r.last_seen_at : `${r.last_seen_at.replace(" ", "T")}Z`) || 0 : 0;
		if (node && (!best || at > best.at)) best = { node, at };
	}
	return best?.node ?? pin.machineId;
}

/** Resolve a stored pin to the machine's current hostname, reading only that machine's rows. */
export async function resolveRunnerPin(env: { DB: D1Database }, userId: string, configJson: string | null | undefined): Promise<RunnerPin & { node: string }> {
	const pin = parseRunnerPin(configJson);
	if (!pin.machineId) return { ...pin, node: pin.legacyNode };
	const { results } = await env.DB.prepare("SELECT runner_node, machine_id, last_seen_at FROM instance_runtime_nodes WHERE user_id = ?1 AND machine_id = ?2")
		.bind(userId, pin.machineId)
		.all<PinNodeRow>();
	return { ...pin, node: pinnedNodeName(pin, results ?? []) };
}

/** Every pin of one owner's instances resolved at once — one read of the owner's identified registrations. */
export async function resolveRunnerPins(env: { DB: D1Database }, userId: string, configs: ReadonlyArray<{ id: string; config: string | null }>): Promise<Map<string, RunnerPin & { node: string }>> {
	const pins = configs.map((c) => ({ id: c.id, pin: parseRunnerPin(c.config) }));
	const rows = pins.some((p) => p.pin.machineId)
		? ((await env.DB.prepare("SELECT runner_node, machine_id, last_seen_at FROM instance_runtime_nodes WHERE user_id = ?1 AND machine_id IS NOT NULL").bind(userId).all<PinNodeRow>()).results ?? [])
		: [];
	return new Map(pins.map((p) => [p.id, { ...p.pin, node: pinnedNodeName(p.pin, rows) }]));
}

/** The hostname an instance's pinned machine answers to now (empty = auto). A platform primitive:
 *  ANY agent instance — not just Coder — can be bound to a specific machine. */
export async function readInstanceRunnerNode(
	env: { DB: D1Database },
	instanceId: string,
	userId: string,
): Promise<string> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.first<{ config: string | null }>();
	return (await resolveRunnerPin(env, userId, row?.config)).node;
}
