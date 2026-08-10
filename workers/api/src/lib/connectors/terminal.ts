// Generic local terminal connector. The cloud side owns auth/consent/tool policy; the local
// runner owns backend-specific adapters (tmux, kitty remote control, iTerm2 AppleScript).
//
// BACKEND CEILING (#404): `backend` here is a REQUEST, not the decision. An agent may declare
// `capabilities.surfaceOptions.terminal.backends` — a subset of the three below — and
// `runRegistryTool` enforces it at dispatch: an out-of-scope `backend`, or a `target` carrying an
// out-of-scope prefix (`iterm2:1:1:1`), is refused before any handler here runs, and an omitted
// `backend` arrives already narrowed to the one permitted value. So a "tmux Operator" is one by
// construction rather than by name, and these handlers need no per-agent branching. Declaring
// nothing leaves every call byte-identical to before the gate existed.
//
// METERING: this connector drives CLIs the platform cannot measure (#348). A pane carries
// rendered text, so an AI coding CLI running in one spends real tokens that reach no ledger row —
// and a missing row on a page of dollars reads as zero dollars. Every WRITE therefore records an
// explicit "not measured" observation via `recordUnmeteredEngineActivity`, so the gap is a
// quantity a reader can see rather than a silence they mistake for thrift.
import type { RegistryToolCtx, ToolDef } from "./types.js";
import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS, type RunnerConn } from "../runner-client.js";
import { noteUnmeteredDrive } from "../engine-metering.js";

type Backend = "tmux" | "kitty" | "iterm2";

async function resolveRunner(ctx: RegistryToolCtx): Promise<{ conn: RunnerConn } | { error: string }> {
	if (!ctx.instanceId || !ctx.userId) return { error: "No instance context for the terminal connector." };
	const conn = await getBoundRunnerConn(ctx.env, ctx.instanceId, ctx.userId).catch(() => null);
	if (!conn) return { error: "No runner is connected for this agent — run `pags up` on the machine whose terminal you want to control." };
	return { conn };
}

function backend(input: Record<string, unknown>): Backend | undefined {
	const b = String(input.backend ?? "").trim().toLowerCase();
	return b === "tmux" || b === "kitty" || b === "iterm2" ? b : undefined;
}

function requireTarget(input: Record<string, unknown>): string {
	const target = String(input.target ?? "").trim();
	if (!target) throw new Error("A `target` is required. Use terminal_list_targets first; targets look like `tmux:main`, `kitty:1`, or `iterm2:1:1:1`.");
	return target;
}

const BACKEND_PROP = {
	type: "string",
	enum: ["tmux", "kitty", "iterm2"],
	description: "Terminal backend. Omit when the target is prefixed, e.g. `tmux:main`.",
};

export const TERMINAL_TOOLS: ToolDef[] = [
	{
		name: "terminal_list_targets",
		tier: "connector",
		connector: "terminal",
		scope: "read",
		description:
			"List controllable local terminal targets on the connected machine across tmux, kitty, and iTerm2. Returns targets like `tmux:main`, `kitty:3`, and `iterm2:1:1:1`; use those exact targets for capture/run/send/kill.",
		jsonSchema: {
			type: "object",
			properties: {
				backend: { type: "string", enum: ["all", "tmux", "kitty", "iterm2"], description: "Optional backend filter. Default: all." },
			},
		},
		handler: async (ctx, input) => {
			const r = await resolveRunner(ctx);
			if ("error" in r) return { content: r.error, success: false };
			const res = await callRunner<{ targets?: unknown[] }>(r.conn, "/terminal/list", { backend: input.backend || "all" }, { timeoutMs: READ_TIMEOUT_MS });
			return { content: JSON.stringify(res.targets ?? [], null, 2), success: true };
		},
	},
	{
		name: "terminal_capture",
		tier: "connector",
		connector: "terminal",
		scope: "read",
		description:
			"Read the current output of a local terminal target. Use terminal_list_targets first, then pass a target like `tmux:main`, `kitty:3`, or `iterm2:1:1:1`.",
		jsonSchema: {
			type: "object",
			properties: {
				target: { type: "string", description: "Terminal target, preferably backend-prefixed." },
				backend: BACKEND_PROP,
				lines: { type: "number", description: "Scrollback lines where supported (tmux only; default 200, max 2000)." },
			},
			required: ["target"],
		},
		handler: async (ctx, input) => {
			const r = await resolveRunner(ctx);
			if ("error" in r) return { content: r.error, success: false };
			const res = await callRunner<{ pane?: string }>(r.conn, "/terminal/capture", { target: requireTarget(input), backend: backend(input), lines: input.lines }, { timeoutMs: READ_TIMEOUT_MS });
			return { content: res.pane ?? "", success: true };
		},
	},
	{
		name: "terminal_run_command",
		tier: "connector",
		connector: "terminal",
		scope: "write",
		description:
			"Type a command line into a local terminal target and press Enter. WRITE: runs on the user's machine. For tmux targets, waits until the pane quiesces before returning; result includes `changed` (false means the pane did not react).",
		jsonSchema: {
			type: "object",
			properties: {
				target: { type: "string", description: "Terminal target, e.g. `tmux:main`, `kitty:3`, or `iterm2:1:1:1`." },
				backend: BACKEND_PROP,
				command: { type: "string", description: "Command line to type and execute." },
			},
			required: ["target", "command"],
		},
		handler: async (ctx, input) => {
			const r = await resolveRunner(ctx);
			if ("error" in r) return { content: r.error, success: false };
			const command = String(input.command ?? "");
			if (!command.trim()) return { content: "A `command` is required.", success: false };
			const target = requireTarget(input);
			const res = await callRunner<{ pane?: string; activeCommand?: string | null }>(r.conn, "/terminal/run", { target, backend: backend(input), command });
			await noteUnmeteredDrive(ctx.env, ctx, { driver: "terminal", target, activeCommand: res.activeCommand });
			return { content: res.pane ?? "Command sent.", success: true };
		},
	},
	{
		name: "terminal_send_keys",
		tier: "connector",
		connector: "terminal",
		scope: "write",
		description:
			"Send literal text and/or named keys to a local terminal target without necessarily pressing Enter — for key-level control: Escape, C-c, arrow keys, or multi-key sequences. WRITE: runs on the user's machine. For tmux targets, waits until the pane quiesces before returning; result includes `changed` (false means the pane did not react — the CLI may not be ready). iTerm2 currently supports text only. To send a message to an interactive CLI and submit it (type text + Enter + confirm landed), use `terminal_send_message` instead.",
		jsonSchema: {
			type: "object",
			properties: {
				target: { type: "string", description: "Terminal target, e.g. `tmux:main`, `kitty:3`, or `iterm2:1:1:1`." },
				backend: BACKEND_PROP,
				text: { type: "string", description: "Literal text to type." },
				keys: { type: "array", description: "Named keys to send, e.g. [\"Enter\"], [\"Escape\"], or [\"C-c\"]." },
			},
			required: ["target"],
		},
		handler: async (ctx, input) => {
			const r = await resolveRunner(ctx);
			if ("error" in r) return { content: r.error, success: false };
			const keys = Array.isArray(input.keys)
				? input.keys.map((k) => String(k).trim()).filter(Boolean)
				: String(input.keys ?? "").split(",").map((k) => k.trim()).filter(Boolean);
			if (input.text == null && keys.length === 0) return { content: "Provide `text` and/or `keys` to send.", success: false };
			const target = requireTarget(input);
			const res = await callRunner<{ pane?: string; paneBefore?: string; changed?: boolean; activeCommand?: string | null }>(r.conn, "/terminal/send", { target, backend: backend(input), text: input.text == null ? undefined : String(input.text), keys });
			await noteUnmeteredDrive(ctx.env, ctx, { driver: "terminal", target, activeCommand: res.activeCommand });
			const landed = res.changed === false ? " (pane did not change — the input may not have landed; is the CLI at its input prompt?)" : "";
			return { content: (res.pane ?? "Sent.") + landed, success: true };
		},
	},
	{
		name: "terminal_send_message",
		tier: "connector",
		connector: "terminal",
		scope: "write",
		description:
			"Send a message to an interactive CLI running in a local terminal target and submit it (types the text, presses Enter, waits for the pane to quiesce, and confirms the input landed). WRITE: runs on the user's machine. Use this — not `terminal_send_keys` — whenever you want to submit a message or command to a running CLI like Claude Code, Codex, or a REPL. Returns `changed: false` with an explicit warning when the pane did not react (CLI not yet at its input prompt — retry after a short wait).",
		jsonSchema: {
			type: "object",
			properties: {
				target: { type: "string", description: "Terminal target, e.g. `tmux:main`, `kitty:3`, or `iterm2:1:1:1`." },
				backend: BACKEND_PROP,
				message: { type: "string", description: "Text to type and submit (sent as-is, then Enter)." },
			},
			required: ["target", "message"],
		},
		handler: async (ctx, input) => {
			const r = await resolveRunner(ctx);
			if ("error" in r) return { content: r.error, success: false };
			const message = String(input.message ?? "");
			if (!message) return { content: "A `message` is required.", success: false };
			const target = requireTarget(input);
			// Send the text then Enter as a single atomic operation: the runner handles
			// text + keys in one /terminal/send call and waits for the pane to quiesce (#481).
			const res = await callRunner<{ pane?: string; paneBefore?: string; changed?: boolean; activeCommand?: string | null }>(
				r.conn,
				"/terminal/send",
				{ target, backend: backend(input), text: message, keys: ["Enter"] },
			);
			await noteUnmeteredDrive(ctx.env, ctx, { driver: "terminal", target, activeCommand: res.activeCommand });
			if (res.changed === false) {
				return {
					content: (res.pane ?? "") + " (pane did not change — message may not have landed; is the CLI at its input prompt? Wait for the prompt and retry.)",
					success: false,
				};
			}
			return { content: res.pane ?? "Message sent.", success: true };
		},
	},
	{
		name: "terminal_new_target",
		tier: "connector",
		connector: "terminal",
		scope: "write",
		description:
			"Create a new local terminal target. tmux creates a detached session; kitty opens an OS window via remote control; iTerm2 opens a new window. WRITE: runs on the user's machine.",
		jsonSchema: {
			type: "object",
			properties: {
				backend: { type: "string", enum: ["tmux", "kitty", "iterm2"], description: "Backend to create the target in." },
				name: { type: "string", description: "Name for tmux, optional display label for GUI terminals." },
				workDir: { type: "string", description: "Working directory to start in." },
				command: { type: "string", description: "Optional startup command." },
			},
			required: ["backend"],
		},
		handler: async (ctx, input) => {
			const r = await resolveRunner(ctx);
			if ("error" in r) return { content: r.error, success: false };
			const b = backend(input);
			if (!b) return { content: "`backend` must be tmux, kitty, or iterm2.", success: false };
			const res = await callRunner<{ target?: unknown }>(r.conn, "/terminal/session", { action: "create", backend: b, name: input.name, workDir: input.workDir, command: input.command });
			// When a startup command was given on tmux, the runner waited for the pane to quiesce
			// before returning (#481), so "ready" is verified rather than assumed.
			const targetData = res.target ?? res;
			const readyNote = input.command && b === "tmux" ? " (startup command ran; pane settled)" : "";
			return { content: JSON.stringify(targetData, null, 2) + readyNote, success: true };
		},
	},
	{
		name: "terminal_kill_target",
		tier: "connector",
		connector: "terminal",
		scope: "write",
		description:
			"Close or kill a local terminal target. tmux kills the session; kitty closes the window; iTerm2 closes the addressed session. WRITE: runs on the user's machine.",
		jsonSchema: {
			type: "object",
			properties: {
				target: { type: "string", description: "Terminal target, e.g. `tmux:main`, `kitty:3`, or `iterm2:1:1:1`." },
				backend: BACKEND_PROP,
			},
			required: ["target"],
		},
		handler: async (ctx, input) => {
			const r = await resolveRunner(ctx);
			if ("error" in r) return { content: r.error, success: false };
			const res = await callRunner<{ killed?: boolean }>(r.conn, "/terminal/session", { action: "kill", target: requireTarget(input), backend: backend(input) });
			return res.killed ? { content: `Closed ${requireTarget(input)}.`, success: true } : { content: `Could not close ${requireTarget(input)}.`, success: false };
		},
	},
];
