// native connector — READ the owner's machine: its running apps, an app's accessibility tree, and the
// phones/emulators Maestro can see (#1057, slice 2).
//
// Native control is a grantable CAPABILITY (owner decision, 2026-10-19), so it lives here, in the
// registry, like tmux and repo-local: any agent whose runtime is `local_native` declares these tools in
// `capabilities.tools`, and they reach the machine over the same runner relay. Nothing is wired to one
// agent. Every tool is scope:"read" AND mutates:false — nothing here clicks, types, launches or
// changes anything; that is slice 3, behind approval gates. Output is the screen's text, which anyone
// who can message the owner wrote, so it is untrusted (ADR 0006). The gate and the audit are in
// `lib/native/read.ts`.
import { NATIVE_SCROLL_MAX, NATIVE_TREE_DEFAULT_DEPTH, NATIVE_TREE_MAX_DEPTH, NATIVE_TREE_MAX_NODES, NATIVE_TYPE_MAX_CHARS, type NativeActTool, type NativeReadTool, nativeActInputError } from "../native/contract.js";
import { runNativeAct, runNativeHalt } from "../native/act.js";
import { getNativeHalt } from "../native/halt.js";
import { runNativeRead } from "../native/read.js";
import { getLiveRuntime } from "../../routes/instances-runtime.js";
import { clipMarked } from "../clip-marked.js";
import type { RegistryToolCtx, RegistryToolResult, ToolDef } from "./types.js";

async function read(ctx: RegistryToolCtx, tool: NativeReadTool, input: Record<string, unknown>): Promise<RegistryToolResult> {
	if (!ctx.instanceId || !ctx.userId) return { content: `${tool} needs an agent instance and its owner.`, success: false };
	const r = await runNativeRead(ctx.env, { instanceId: ctx.instanceId, userId: ctx.userId }, tool, input);
	return r.ok ? { content: r.content, success: true } : { content: `${r.code}: ${r.message}`, success: false };
}

async function act(ctx: RegistryToolCtx, tool: NativeActTool, input: Record<string, unknown>): Promise<RegistryToolResult> {
	if (!ctx.instanceId || !ctx.userId) return { content: `${tool} needs an agent instance and its owner.`, success: false };
	const r = await runNativeAct(ctx.env, { instanceId: ctx.instanceId, userId: ctx.userId }, tool, input);
	return r.ok ? { content: r.content, success: true } : { content: `${r.code}: ${r.message}`, success: false };
}

/**
 * Every call to click, type or press a key waits for the OWNER (the registry's per-call approval, #719/#722): the card says what will
 * happen, with the exact text for typing. Validated here so nothing the runner would refuse is ever put in front of the owner, and a
 * halted machine never produces a card at all.
 */
const prepareInput = (tool: "native_click" | "native_type" | "native_key"): NonNullable<ToolDef["approval"]>["prepare"] => async (ctx, args) => {
	const invalid = nativeActInputError(tool, args);
	if (invalid) return { ok: false, error: invalid };
	if (!ctx.env || !ctx.userId || !ctx.instanceId) return { ok: false, error: `${tool} needs an agent instance and its owner.` };
	const runtime = await getLiveRuntime(ctx.env, ctx.instanceId, ctx.userId).catch(() => null);
	if (runtime?.machine_id && (await getNativeHalt(ctx.env, ctx.userId, runtime.machine_id))) return { ok: false, error: "NATIVE_HALTED: native control on the owner's machine is halted. Nothing was queued. Only the owner can resume it." };
	const where = runtime?.runner_node ? ` on ${runtime.runner_node}` : "";
	const why = typeof args.why === "string" && args.why.trim() ? args.why.trim() : "The agent gave no reason.";
	const what =
		tool === "native_click"
			? `Click${args.double === true ? " (double)" : ""} at screen position (${args.x}, ${args.y}) with the ${args.button === "right" ? "right" : "left"} mouse button${where}.`
			: tool === "native_type"
				? `Type ${(args.text as string).length} character(s) into whatever is focused${where}:\n${clipMarked(args.text, 500, { within: true })}`
				: `Press ${args.key}${where}.`;
	const title = tool === "native_click" ? "Agent wants to click on your screen" : tool === "native_type" ? "Agent wants to type on your keyboard" : "Agent wants to press a key";
	return { ok: true, args, card: { title, description: what, reasoning: clipMarked(why, 300, { within: true }) } };
};

const READ = { tier: "connector", connector: "native", scope: "read", mutates: false, untrustedOutput: true } as const;

// Act output is the platform's own sentence (coordinates, a count, a path) — nothing the screen said — so it is not untrusted material.
const ACT = { tier: "connector", connector: "native", scope: "write", mutates: true, untrustedOutput: false } as const;
const WHY = { type: "string", description: "Why, in a sentence — shown to the owner on the approval card." } as const;

export const NATIVE_TOOLS: ToolDef[] = [
	{
		...READ,
		name: "native_list_apps",
		description: "List the apps running with a window on the owner's machine (the one running `pags up` for this agent): name, process id, and which one is in front. Read-only. Use it to find an app's exact name before native_accessibility_tree.",
		jsonSchema: { type: "object", properties: {} },
		handler: (ctx) => read(ctx, "native_list_apps", {}),
	},
	{
		...READ,
		name: "native_accessibility_tree",
		description: `Read what an app on the owner's machine is showing, as its accessibility tree: each element's role, name and value (text on screen, labels, fields). Read-only — it does not click, type or switch apps. Defaults to the app in front; name another with \`app\` (exact name from native_list_apps). At most ${NATIVE_TREE_MAX_NODES} elements, ${NATIVE_TREE_DEFAULT_DEPTH} levels deep by default (\`maxDepth\` up to ${NATIVE_TREE_MAX_DEPTH}); a cut tree says so. Needs the machine's Accessibility permission (macOS) — a missing permission is reported, never waited on.`,
		jsonSchema: {
			type: "object",
			properties: {
				app: { type: "string", description: "The app's visible name, from native_list_apps. Omit for the app in front." },
				maxDepth: { type: "integer", description: `Levels below each window (1–${NATIVE_TREE_MAX_DEPTH}, default ${NATIVE_TREE_DEFAULT_DEPTH}).` },
			},
		},
		handler: (ctx, input) => read(ctx, "native_accessibility_tree", { ...(input.app !== undefined ? { app: input.app } : {}), ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}) }),
	},
	{
		...READ,
		name: "native_maestro_devices",
		description: "List the Android devices/emulators and booted iOS simulators connected to the owner's machine, and which are ready for Maestro. Read-only. Maestro must already be installed — the runner never installs anything.",
		jsonSchema: { type: "object", properties: {} },
		handler: (ctx) => read(ctx, "native_maestro_devices", {}),
	},
	{
		...READ,
		name: "native_maestro_hierarchy",
		description: `Read what a phone or emulator is showing, as Maestro's UI hierarchy: each element's class, text and resource id. Read-only — it does not tap or type. \`deviceId\` comes from native_maestro_devices. At most ${NATIVE_TREE_MAX_NODES} elements; a cut tree says so.`,
		jsonSchema: {
			type: "object",
			properties: { deviceId: { type: "string", description: "The device id from native_maestro_devices (adb serial or simulator UDID)." } },
			required: ["deviceId"],
		},
		handler: (ctx, input) => read(ctx, "native_maestro_hierarchy", { deviceId: input.deviceId }),
	},
	{
		...ACT,
		name: "native_launch_app",
		description: "Open an app on the owner's machine by its visible name or bundle id (never a path). Look first with native_list_apps. Desktop opt-in required.",
		jsonSchema: { type: "object", properties: { app: { type: "string", description: "The app's visible name, e.g. WeChat." } }, required: ["app"] },
		handler: (ctx, input) => act(ctx, "native_launch_app", { app: input.app }),
	},
	{
		...ACT,
		name: "native_click",
		description: "Click at a screen position on the owner's machine. EVERY call waits for the owner's approval. Find positions by taking a screenshot or reading the UI first.",
		jsonSchema: {
			type: "object",
			properties: { x: { type: "integer" }, y: { type: "integer" }, button: { type: "string", enum: ["left", "right"] }, double: { type: "boolean" }, why: WHY },
			required: ["x", "y"],
		},
		approval: { everyCall: true, prepare: prepareInput("native_click") },
		handler: (ctx, input) => act(ctx, "native_click", { x: input.x, y: input.y, ...(input.button !== undefined ? { button: input.button } : {}), ...(input.double !== undefined ? { double: input.double } : {}) }),
	},
	{
		...ACT,
		name: "native_type",
		description: `Type text into whatever is focused on the owner's machine (at most ${NATIVE_TYPE_MAX_CHARS} characters). EVERY call waits for the owner's approval, who sees the exact text. Never type passwords, codes or secrets — a password field is refused; hand sign-in to the owner.`,
		jsonSchema: { type: "object", properties: { text: { type: "string" }, why: WHY }, required: ["text"] },
		approval: { everyCall: true, prepare: prepareInput("native_type") },
		handler: (ctx, input) => act(ctx, "native_type", { text: input.text }),
	},
	{
		...ACT,
		name: "native_key",
		description: "Press a key, with optional modifiers, on the owner's machine: return, tab, escape, cmd+a, ctrl+shift+t. EVERY call waits for the owner's approval.",
		jsonSchema: { type: "object", properties: { key: { type: "string", description: "e.g. return, tab, cmd+a. Modifiers: cmd, ctrl, alt, shift." }, why: WHY }, required: ["key"] },
		approval: { everyCall: true, prepare: prepareInput("native_key") },
		handler: (ctx, input) => act(ctx, "native_key", { key: input.key }),
	},
	{
		...ACT,
		name: "native_scroll",
		description: `Scroll where the pointer is, in lines (-${NATIVE_SCROLL_MAX}..${NATIVE_SCROLL_MAX}; down is negative). Changes only the view.`,
		jsonSchema: { type: "object", properties: { dy: { type: "integer" }, dx: { type: "integer" } } },
		handler: (ctx, input) => act(ctx, "native_scroll", { ...(input.dy !== undefined ? { dy: input.dy } : {}), ...(input.dx !== undefined ? { dx: input.dx } : {}) }),
	},
	{
		...ACT,
		scope: "read",
		name: "native_screenshot",
		description: "Save a screenshot of the owner's screen ON their machine. The image is never returned to you (it can show anything); you get its size and where it is. To read the screen, use native_accessibility_tree.",
		jsonSchema: { type: "object", properties: {} },
		handler: (ctx) => act(ctx, "native_screenshot", {}),
	},
	{
		...ACT,
		scope: "read",
		name: "native_halt",
		description: "STOP all native control on the owner's machine now. Every native tool then refuses until the owner resumes it. Use it when unsure, when something goes wrong, or when asked to stop.",
		jsonSchema: { type: "object", properties: { reason: { type: "string", description: "Why you stopped, in a sentence." } } },
		handler: async (ctx, input) => {
			if (!ctx.instanceId || !ctx.userId) return { content: "native_halt needs an agent instance and its owner.", success: false };
			const r = await runNativeHalt(ctx.env, { instanceId: ctx.instanceId, userId: ctx.userId }, typeof input.reason === "string" ? input.reason : undefined);
			return r.ok ? { content: r.content, success: true } : { content: `${r.code}: ${r.message}`, success: false };
		},
	},
];
