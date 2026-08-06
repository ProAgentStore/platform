import type { Env } from "../types.js";
import { agentCapabilities } from "./agent-capabilities.js";
import { patchInstanceConfig, removeInstanceConfigKey } from "./instance-config.js";
import { loopDriverFor } from "./loop-drivers.js";
import { resolveLoopPresets, sanitizeLoopPresets, type LoopPreset, type LoopPresetSource } from "./loop-presets.js";

/**
 * D1 access for loop presets (#234) — the mirror of `behaviour-store.ts`, and split from the pure
 * `loop-presets.ts` for the same reason: the resolution order is the interesting part and it should
 * be testable without a database.
 */

const KEY = "loopPresets";

interface Row {
	config: string | null;
	agent_config: string | null;
	slug: string | null;
	category: string | null;
}

const SELECT =
	"SELECT i.config AS config, a.config AS agent_config, a.slug AS slug, a.category AS category" +
	" FROM agent_instances i LEFT JOIN agents a ON a.id = i.agent_id WHERE i.id = ?1 AND i.user_id = ?2";

export interface ResolvedLoopPresets {
	presets: LoopPreset[];
	source: LoopPresetSource;
	/** What this instance's Loop actually drives — the console labels the form with it. */
	driver: string;
}

/** Creator template default under the subscriber's override, falling back to the driver default. */
export async function readLoopPresets(env: Env, instanceId: string, userId: string): Promise<ResolvedLoopPresets> {
	const row = await env.DB.prepare(SELECT).bind(instanceId, userId).first<Row>();
	return resolveRow(env, row);
}

/**
 * Save the subscriber's own list. An EMPTY list clears the override instead of storing `[]`, so
 * "remove the last one" and "give me the defaults back" are the same gesture and the instance
 * resumes inheriting whatever the creator ships.
 *
 * Writes through `patchInstanceConfig`: `agent_instances.config` also holds settings, behaviour,
 * board, translation and coding engines, and a read-modify-write of the whole blob silently
 * discards a concurrent change to any of them (#231).
 */
export async function writeLoopPresets(
	env: Env,
	instanceId: string,
	userId: string,
	raw: unknown,
): Promise<ResolvedLoopPresets | null> {
	const presets = sanitizeLoopPresets(raw);
	const ok = presets.length
		? await patchInstanceConfig(env, instanceId, userId, KEY, presets)
		: await removeInstanceConfigKey(env, instanceId, userId, KEY);
	if (!ok) return null;
	const row = await env.DB.prepare(SELECT).bind(instanceId, userId).first<Row>();
	return resolveRow(env, row);
}

function resolveRow(env: Env, row: Row | null): ResolvedLoopPresets {
	if (!row) return { presets: [], source: "default", driver: "chat" };
	const caps = agentCapabilities(
		{ slug: row.slug, category: row.category, config: row.agent_config } as never,
		env as never,
	);
	const driver = loopDriverFor(caps).id;
	const { presets, source } = resolveLoopPresets({
		agentConfig: parse(row.agent_config),
		instanceConfig: parse(row.config),
		driverId: driver,
	});
	return { presets, source, driver };
}

function parse(raw: string | null): Record<string, unknown> {
	try {
		return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}
