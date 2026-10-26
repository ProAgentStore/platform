/**
 * The cloud half of the native ACT tools (#1057, slice 3) — what the `native` connector's launch, click, type, key, scroll and
 * screenshot tools run, and the agent's `native_halt`.
 *
 * In order, before the runner is asked anything:
 *   1. the instance's agent runs the `local_native` runtime;
 *   2. the input is well-formed (the contract's validator, the same one the runner applies);
 *   3. the gate (`nativeGate`): a live runner naming its machine, the owner's opt-in for the desktop backend, a runner that serves act;
 *   4. the machine is NOT halted (`native_halts`).
 * Click, type and key also waited for the owner's approval before this ran at all (the registry's per-call approval — see
 * `connectors/native.ts`); a halt that arrives between the approval and here still refuses.
 *
 * The AUDIT is a `native_runs` row per call with `run.requested` and then `action.performed` / `action.refused` / `screenshot.taken` /
 * `run.failed`. The detail is metadata only — the tool, machine and node, coordinates, a key spec, the LENGTH of typed text,
 * a screenshot's size, a failure's code — never what was typed, what was on screen, or an image.
 */
import type { Env } from "../../types.js";
import { callRuntime, getLiveRuntime, runtimeJson } from "../../routes/instances-runtime.js";
import { agentCapabilities } from "../agent-capabilities.js";
import {
	NATIVE_ACT_CAPABILITY,
	NATIVE_ACT_ROUTES,
	type NativeActTool,
	type NativeErrorCode,
	type NativeReadResult,
	type NativeScreenshotData,
	nativeActInputError,
} from "./contract.js";
import { getNativeHalt, haltNative } from "./halt.js";
import { nativeGate } from "./preflight.js";

export type NativeActOutcome = { ok: true; content: string; runId: string } | { ok: false; code: NativeErrorCode; message: string; runId?: string };

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

/** What an audit line may say about the call's input: facts about it, never its content. */
export function auditFacts(tool: NativeActTool, input: Record<string, unknown>): Record<string, unknown> {
	switch (tool) {
		case "native_launch_app":
			return { app: input.app };
		case "native_click":
			return { x: input.x, y: input.y, button: input.button ?? "left", double: input.double === true };
		case "native_type":
			return { chars: typeof input.text === "string" ? input.text.length : 0 };
		case "native_key":
			return { key: input.key };
		case "native_scroll":
			return { dx: input.dx ?? 0, dy: input.dy ?? 0 };
		case "native_screenshot":
			return {};
	}
}

/** The input a runner may be sent: the contract's fields only — `why` and anything else the model added stay in the cloud. */
export function runnerBody(tool: NativeActTool, input: Record<string, unknown>): Record<string, unknown> {
	const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
	switch (tool) {
		case "native_launch_app":
			return pick(["app"]);
		case "native_click":
			return pick(["x", "y", "button", "double"]);
		case "native_type":
			return pick(["text"]);
		case "native_key":
			return pick(["key"]);
		case "native_scroll":
			return pick(["dx", "dy"]);
		case "native_screenshot":
			return {};
	}
}

const DESCRIBE: Record<NativeActTool, (input: Record<string, unknown>) => string> = {
	native_launch_app: (i) => `Opened ${JSON.stringify(i.app)}.`,
	native_click: (i) => `Clicked at (${i.x}, ${i.y})${i.button === "right" ? " with the right button" : ""}${i.double === true ? " twice" : ""}.`,
	native_type: (i) => `Typed ${(i.text as string).length} character(s).`,
	native_key: (i) => `Pressed ${i.key}.`,
	native_scroll: (i) => `Scrolled by ${i.dx ?? 0} across, ${i.dy ?? 0} down (lines).`,
	native_screenshot: () => "",
};

export async function runNativeAct(env: Env, ctx: { instanceId: string; userId: string }, tool: NativeActTool, input: Record<string, unknown>): Promise<NativeActOutcome> {
	const runtime = await instanceRuntime(env, ctx.instanceId, ctx.userId);
	if (runtime === undefined) return { ok: false, code: "NATIVE_INVALID_REQUEST", message: "Instance not found." };
	if (runtime !== "local_native") {
		return { ok: false, code: "NATIVE_NOT_ENABLED", message: `${tool} works for an agent whose runtime is local_native (native desktop / Maestro control); this agent's runtime is ${runtime ?? "none"}.` };
	}
	const invalid = nativeActInputError(tool, input);
	if (invalid) return { ok: false, code: "NATIVE_INVALID_REQUEST", message: invalid };
	const route = NATIVE_ACT_ROUTES[tool];
	const gate = await nativeGate(env, ctx.instanceId, ctx.userId, { capability: NATIVE_ACT_CAPABILITY, backend: route.backend, what: "the native act tools" });
	if (!gate.ok) return { ok: false, code: gate.refusal.body.code, message: gate.refusal.body.error };

	const runId = crypto.randomUUID();
	await env.DB.prepare("INSERT INTO native_runs (id, instance_id, user_id, machine_id, backend, status, config) VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6)")
		.bind(runId, ctx.instanceId, ctx.userId, gate.machineId, route.backend, JSON.stringify({ backend: route.backend, targetApp: typeof input.app === "string" ? input.app : "", readOnly: false, tool }))
		.run();
	const base = { tool, machineId: gate.machineId, node: gate.runtime.runner_node, ...auditFacts(tool, input) };
	await event(env, runId, ctx.instanceId, 1, "run.requested", base);

	const finish = async (status: "completed" | "failed" | "cancelled", seq: number, type: string, detail: Record<string, unknown>, code?: string): Promise<void> => {
		await event(env, runId, ctx.instanceId, seq, type, detail);
		await env.DB.prepare("UPDATE native_runs SET status = ?2, error_code = ?3, updated_at = datetime('now') WHERE id = ?1").bind(runId, status, code ?? null).run();
	};

	const halted = await getNativeHalt(env, ctx.userId, gate.machineId);
	if (halted) {
		await finish("cancelled", 2, "action.refused", { ...base, code: "NATIVE_HALTED", haltedBy: halted.by }, "NATIVE_HALTED");
		return { ok: false, code: "NATIVE_HALTED", message: `Native control on ${gate.runtime.runner_node} is halted (by the ${halted.by}). Nothing was done. Only the owner can resume it.`, runId };
	}

	let result: NativeReadResult<unknown>;
	try {
		const res = await callRuntime(env, gate.runtime, route.path, { method: "POST", body: JSON.stringify(runnerBody(tool, input)) });
		result = res.status === 404
			? { ok: false, code: "NATIVE_RUNNER_UNSUPPORTED", message: `The runner on ${gate.runtime.runner_node} does not know ${route.path}. Update the CLI and run \`pags up\` again.` }
			: ((await runtimeJson(res)) as NativeReadResult<unknown>);
		if (!result || typeof result !== "object" || typeof (result as { ok?: unknown }).ok !== "boolean") {
			result = { ok: false, code: "NATIVE_RUNNER_UNREACHABLE", message: `The runner on ${gate.runtime.runner_node} did not answer ${tool} (HTTP ${res.status}).` };
		}
	} catch {
		result = { ok: false, code: "NATIVE_RUNNER_UNREACHABLE", message: `The runner on ${gate.runtime.runner_node} could not be reached. Nothing is known to have happened; check \`pags up\` on that machine.` };
	}

	if (!result.ok) {
		const refused = result.code === "NATIVE_HALTED" || result.code === "NATIVE_SECURE_FIELD";
		await finish(refused ? "cancelled" : "failed", 2, refused ? "action.refused" : "run.failed", { ...base, code: result.code }, result.code);
		return { ok: false, code: result.code, message: result.message, runId };
	}
	if (tool === "native_screenshot") {
		const shot = result.data as NativeScreenshotData;
		await finish("completed", 2, "screenshot.taken", { ...base, bytes: shot.bytes, sha256: shot.sha256 });
		return {
			ok: true,
			runId,
			content: `Screenshot saved on ${gate.runtime.runner_node} (${shot.bytes} bytes, sha256 ${shot.sha256}) at ${shot.path}. The image is not sent to you: it stays on the owner's machine, where they can open it. To see what is on screen, use native_accessibility_tree.`,
		};
	}
	await finish("completed", 2, "action.performed", base);
	return { ok: true, content: DESCRIBE[tool](input), runId };
}

/**
 * The agent's own stop (`native_halt`). Needs only that the instance is the caller's and has a machine — not the opt-in, not the
 * runtime check: a stop must work whenever something is running, and a halt of nothing is harmless.
 */
export async function runNativeHalt(env: Env, ctx: { instanceId: string; userId: string }, reason?: string): Promise<{ ok: true; content: string } | { ok: false; code: NativeErrorCode; message: string }> {
	const runtime = await getLiveRuntime(env, ctx.instanceId, ctx.userId).catch(() => null);
	const machineId = runtime?.machine_id ?? null;
	if (!machineId) {
		return { ok: false, code: "NATIVE_RUNNER_UNREACHABLE", message: "No runner with a known machine is connected for this agent, so there is nothing to halt — and nothing can act while it is away." };
	}
	const out = await haltNative(env, ctx.userId, machineId, "agent", reason);
	return {
		ok: true,
		content: `Native control on ${runtime?.runner_node} is halted${out.runnerTold ? "" : " in the cloud (the machine's runner could not be reached; the cloud refuses every native action regardless)"}. Every native tool now refuses until the owner resumes it. Do not try to continue; tell the owner why you stopped.`,
	};
}
