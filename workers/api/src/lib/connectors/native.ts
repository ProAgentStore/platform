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
import { NATIVE_TREE_DEFAULT_DEPTH, NATIVE_TREE_MAX_DEPTH, NATIVE_TREE_MAX_NODES, type NativeReadTool } from "../native/contract.js";
import { runNativeRead } from "../native/read.js";
import type { RegistryToolCtx, RegistryToolResult, ToolDef } from "./types.js";

async function read(ctx: RegistryToolCtx, tool: NativeReadTool, input: Record<string, unknown>): Promise<RegistryToolResult> {
	if (!ctx.instanceId || !ctx.userId) return { content: `${tool} needs an agent instance and its owner.`, success: false };
	const r = await runNativeRead(ctx.env, { instanceId: ctx.instanceId, userId: ctx.userId }, tool, input);
	return r.ok ? { content: r.content, success: true } : { content: `${r.code}: ${r.message}`, success: false };
}

const READ = { tier: "connector", connector: "native", scope: "read", mutates: false, untrustedOutput: true } as const;

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
];
