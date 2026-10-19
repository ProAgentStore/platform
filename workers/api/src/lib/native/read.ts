/**
 * The cloud half of the native READ tools (#1057, slice 2) — what the `native` connector's tools run.
 *
 * Native control is a CAPABILITY, not one agent's feature (owner decision, 2026-10-19): any agent whose
 * runtime is `local_native` and which declares these tools may use them, on a machine its owner opted
 * in for that backend. In order, before the runner is asked anything:
 *   1. the instance's agent runs the `local_native` runtime;
 *   2. the input is well-formed (the contract's own validator, the same one the runner applies);
 *   3. the gate (`nativeGate`): a live runner naming its machine, the owner's opt-in for THIS tool's
 *      backend on that machine, a runner that serves the reads.
 * Every call that passes is a `native_runs` row with its events — metadata only (tool, machine, node
 * and item counts, a failure's code), never what the screen showed.
 */
import type { Env } from "../../types.js";
import { agentCapabilities } from "../agent-capabilities.js";
import { callRuntime, runtimeJson } from "../../routes/instances-runtime.js";
import {
	NATIVE_READ_CAPABILITY,
	NATIVE_READ_ROUTES,
	type NativeErrorCode,
	type NativeListAppsData,
	type NativeMaestroDevicesData,
	type NativeReadResult,
	type NativeReadTool,
	type NativeTree,
	type NativeUiNode,
	nativeReadInputError,
} from "./contract.js";
import { nativeGate } from "./preflight.js";

export type NativeReadOutcome = { ok: true; content: string; runId: string } | { ok: false; code: NativeErrorCode; message: string; runId?: string };

/** The instance's resolved runtime, or null when it is not the caller's instance. */
async function instanceRuntime(env: Env, instanceId: string, userId: string): Promise<string | null | undefined> {
	const row = await env.DB.prepare("SELECT a.slug AS slug, a.category AS category, a.config AS config FROM agent_instances i JOIN agents a ON a.id = i.agent_id WHERE i.id = ?1 AND i.user_id = ?2")
		.bind(instanceId, userId)
		.first<{ slug: string | null; category: string | null; config: string | null }>();
	if (!row) return undefined;
	return agentCapabilities({ slug: row.slug, category: row.category, config: row.config }).runtime;
}

async function event(env: Env, runId: string, instanceId: string, seq: number, type: string, detail: Record<string, unknown>): Promise<void> {
	await env.DB.prepare("INSERT INTO native_run_events (id, run_id, instance_id, seq, type, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
		.bind(crypto.randomUUID(), runId, instanceId, seq, type, JSON.stringify(detail))
		.run();
}

export async function runNativeRead(env: Env, ctx: { instanceId: string; userId: string }, tool: NativeReadTool, input: Record<string, unknown>): Promise<NativeReadOutcome> {
	const runtime = await instanceRuntime(env, ctx.instanceId, ctx.userId);
	if (runtime === undefined) return { ok: false, code: "NATIVE_INVALID_REQUEST", message: "Instance not found." };
	if (runtime !== "local_native") {
		return { ok: false, code: "NATIVE_NOT_ENABLED", message: `${tool} works for an agent whose runtime is local_native (native desktop / Maestro control); this agent's runtime is ${runtime ?? "none"}.` };
	}
	const invalid = nativeReadInputError(tool, input);
	if (invalid) return { ok: false, code: "NATIVE_INVALID_REQUEST", message: invalid };
	const route = NATIVE_READ_ROUTES[tool];
	const gate = await nativeGate(env, ctx.instanceId, ctx.userId, { capability: NATIVE_READ_CAPABILITY, backend: route.backend, what: "the native read tools" });
	if (!gate.ok) return { ok: false, code: gate.refusal.body.code, message: gate.refusal.body.error };

	const runId = crypto.randomUUID();
	const target = typeof input.app === "string" ? input.app : typeof input.deviceId === "string" ? input.deviceId : "";
	await env.DB.prepare("INSERT INTO native_runs (id, instance_id, user_id, machine_id, backend, status, config) VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6)")
		.bind(runId, ctx.instanceId, ctx.userId, gate.machineId, route.backend, JSON.stringify({ backend: route.backend, targetApp: target, readOnly: true, tool }))
		.run();
	const base = { tool, machineId: gate.machineId, node: gate.runtime.runner_node };
	await event(env, runId, ctx.instanceId, 1, "run.requested", base);

	let result: NativeReadResult<unknown>;
	try {
		const res = await callRuntime(env, gate.runtime, route.path, { method: "POST", body: JSON.stringify(input) });
		result = res.status === 404
			? { ok: false, code: "NATIVE_RUNNER_UNSUPPORTED", message: `The runner on ${gate.runtime.runner_node} does not know ${route.path}. Update the CLI and run \`pags up\` again.` }
			: ((await runtimeJson(res)) as NativeReadResult<unknown>);
		if (!result || typeof result !== "object" || typeof (result as { ok?: unknown }).ok !== "boolean") {
			result = { ok: false, code: "NATIVE_RUNNER_UNREACHABLE", message: `The runner on ${gate.runtime.runner_node} did not answer ${tool} (HTTP ${res.status}).` };
		}
	} catch {
		result = { ok: false, code: "NATIVE_RUNNER_UNREACHABLE", message: `The runner on ${gate.runtime.runner_node} could not be reached. Check \`pags up\` on that machine.` };
	}

	if (!result.ok) {
		await event(env, runId, ctx.instanceId, 2, "run.failed", { ...base, code: result.code });
		await env.DB.prepare("UPDATE native_runs SET status = 'failed', error_code = ?2, updated_at = datetime('now') WHERE id = ?1").bind(runId, result.code).run();
		return { ok: false, code: result.code, message: result.message, runId };
	}
	const { content, counts } = render(tool, result.data);
	await event(env, runId, ctx.instanceId, 2, "screen.read", { ...base, ...counts });
	await env.DB.prepare("UPDATE native_runs SET status = 'completed', updated_at = datetime('now') WHERE id = ?1").bind(runId).run();
	return { ok: true, content, runId };
}

/** One node per line, indented by depth: `role "name" = value [id]`. */
export function renderTree(tree: NativeTree): string {
	const lines: string[] = [];
	const walk = (n: NativeUiNode, depth: number) => {
		const parts = [n.role, n.name ? JSON.stringify(n.name) : "", n.value ? `= ${JSON.stringify(n.value)}` : "", n.id ? `[${n.id}]` : ""].filter(Boolean);
		lines.push(`${"  ".repeat(depth)}${parts.join(" ")}`);
		for (const c of n.children ?? []) walk(c, depth + 1);
	};
	if (tree.root) walk(tree.root, 0);
	const head = `UI of ${tree.of} — ${tree.nodes} element(s)${tree.truncated ? ", CUT SHORT by the node or depth limit (narrow with a smaller target, or a lower maxDepth reads less)" : ""}:`;
	return [head, ...(lines.length ? lines : ["(no elements)"])].join("\n");
}

function render(tool: NativeReadTool, data: unknown): { content: string; counts: Record<string, unknown> } {
	if (tool === "native_list_apps") {
		const { apps } = data as NativeListAppsData;
		const lines = apps.map((a) => `- ${a.name} (pid ${a.pid}${a.bundleId ? `, ${a.bundleId}` : ""}${a.windowTitle ? `, window ${JSON.stringify(a.windowTitle)}` : ""})${a.frontmost ? " ← in front" : ""}`);
		return { content: [`${apps.length} app(s) with a window are running:`, ...lines].join("\n"), counts: { apps: apps.length } };
	}
	if (tool === "native_maestro_devices") {
		const { devices } = data as NativeMaestroDevicesData;
		const usable = devices.filter((d) => d.state === "device" || d.state === "Booted");
		const lines = devices.map((d) => `- ${d.id} — ${d.name} (${d.kind === "android" ? "Android" : "iOS simulator"}, ${d.state})${d.state === "device" || d.state === "Booted" ? "" : " — not ready"}`);
		return { content: [`${devices.length} device(s), ${usable.length} ready for Maestro:`, ...(lines.length ? lines : ["(none connected)"])].join("\n"), counts: { devices: devices.length, ready: usable.length } };
	}
	const tree = data as NativeTree;
	return { content: renderTree(tree), counts: { nodes: tree.nodes, truncated: tree.truncated } };
}
