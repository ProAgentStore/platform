/**
 * The HALT on a machine's native control (#1057, slice 3): "the user can halt the agent at any time".
 *
 * Two layers, so the stop holds when one of them is unavailable:
 *   - the cloud's `native_halts` row — checked by every act tool BEFORE the runner is asked anything;
 *   - the runner's own flag (`/native/halt`) — it refuses every act route itself, even if the cloud is later unreachable.
 *
 * The agent may halt (its `native_halt` tool). It can never resume: only the owner clears a halt, through the owner route.
 */
import type { Env } from "../../types.js";
import { logEvent } from "../events.js";
import { clipMarked } from "../clip-marked.js";
import { callRuntime, getLiveRuntime } from "../../routes/instances-runtime.js";
import { NATIVE_HALT_PATH, NATIVE_RESUME_PATH } from "./contract.js";

export interface NativeHalt {
	machineId: string;
	by: "agent" | "owner";
	reason: string | null;
	at: string;
}

export async function getNativeHalt(env: Env, userId: string, machineId: string): Promise<NativeHalt | null> {
	const row = await env.DB.prepare("SELECT machine_id, halted_by, reason, halted_at FROM native_halts WHERE user_id = ?1 AND machine_id = ?2")
		.bind(userId, machineId)
		.first<{ machine_id: string; halted_by: "agent" | "owner"; reason: string | null; halted_at: string }>();
	return row ? { machineId: row.machine_id, by: row.halted_by, reason: row.reason, at: row.halted_at } : null;
}

/** Tell a machine's runner about the halt/resume, through any of the owner's instances attached to it. Best-effort: the cloud row is the authority. */
async function tellRunner(env: Env, userId: string, machineId: string, path: string): Promise<boolean> {
	const rows = (await env.DB.prepare("SELECT instance_id FROM instance_runtime_nodes WHERE user_id = ?1 AND machine_id = ?2").bind(userId, machineId).all<{ instance_id: string }>()).results ?? [];
	for (const r of rows) {
		const runtime = await getLiveRuntime(env, r.instance_id, userId).catch(() => null);
		if (!runtime) continue;
		const res = await callRuntime(env, runtime, path, { method: "POST", body: "{}" }).catch(() => null);
		if (res?.ok) return true;
	}
	return false;
}

export interface HaltOutcome {
	halted: boolean;
	/** Did the machine's runner confirm? False when no runner was reachable — the cloud still refuses every act. */
	runnerTold: boolean;
}

/** Halt native control on a machine. Idempotent; the first halt's author and reason stand. */
export async function haltNative(env: Env, userId: string, machineId: string, by: "agent" | "owner", reason?: string): Promise<HaltOutcome> {
	await env.DB.prepare("INSERT OR IGNORE INTO native_halts (user_id, machine_id, halted_by, reason) VALUES (?1, ?2, ?3, ?4)")
		.bind(userId, machineId, by, reason ? clipMarked(reason, 300, { within: true }) : null)
		.run();
	// Runs in flight are over: nothing may carry on past a halt.
	await env.DB.prepare("UPDATE native_runs SET status = 'cancelled', updated_at = datetime('now') WHERE user_id = ?1 AND machine_id = ?2 AND status IN ('queued', 'running', 'paused')").bind(userId, machineId).run();
	const runnerTold = await tellRunner(env, userId, machineId, NATIVE_HALT_PATH);
	await logEvent(env, { source: "tool", event: "native.halted", level: "warn", userId, message: `native control halted on a machine by the ${by}${runnerTold ? "" : " (runner not reachable; the cloud refuses every act)"}`, context: { machineId, by, runnerTold } }).catch(() => undefined);
	return { halted: true, runnerTold };
}

/** The owner's resume. Returns whether a halt was in place. */
export async function resumeNative(env: Env, userId: string, machineId: string): Promise<{ wasHalted: boolean; runnerTold: boolean }> {
	const was = await getNativeHalt(env, userId, machineId);
	await env.DB.prepare("DELETE FROM native_halts WHERE user_id = ?1 AND machine_id = ?2").bind(userId, machineId).run();
	const runnerTold = await tellRunner(env, userId, machineId, NATIVE_RESUME_PATH);
	await logEvent(env, { source: "tool", event: "native.resumed", userId, message: `native control resumed on a machine by the owner${runnerTold ? "" : " (runner not reachable; it stays halted there until it is told or restarted)"}`, context: { machineId, wasHalted: !!was, runnerTold } }).catch(() => undefined);
	return { wasHalted: !!was, runnerTold };
}
