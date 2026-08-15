// tmux connector — a LOCAL connector (unlike GitHub/Drive, which reach cloud APIs).
// Its "credential" is simply that the user's runner (`pags up`) is connected: the
// handlers reach the machine over the WebSocket relay (getBoundRunnerConn + callRunner),
// the same path the coding tools use. So there's no OAuth flow and no grant table —
// machine ownership is already enforced by the relay-token handshake.
//
// Reads (list/capture) are always allowed once the runner is online. Writes (send keys,
// run a command, create/kill a session) are `scope:"write"`, so runRegistryTool refuses
// them unless the instance has "tmux" write-consent (instance_connector_consent, 0051).
// This is the terminal surface any permitted agent can use to drive shells, git, and
// even other CLIs (Claude/Codex) running in the user's own tmux sessions.
//
// METERING: a pane is rendered text, so a coding CLI driven here spends tokens the platform
// cannot measure (#348). Every write records an explicit "not measured" observation rather than
// contributing nothing — a session missing from a ledger of dollars otherwise reads as free.
import type { ToolDef, RegistryToolCtx } from "./types.js";
import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS, type RunnerConn } from "../runner-client.js";
import { noteUnmeteredDrive } from "../engine-metering.js";

/** Resolve the live runner for this instance, or a helpful error string. */
async function resolveRunner(ctx: RegistryToolCtx): Promise<{ conn: RunnerConn } | { error: string }> {
	if (!ctx.instanceId || !ctx.userId) return { error: "No instance context for the tmux connector." };
	const conn = await getBoundRunnerConn(ctx.env, ctx.instanceId, ctx.userId).catch(() => null);
	if (!conn) return { error: "No runner is connected for this agent — run `pags up` on the machine whose tmux you want to control." };
	return { conn };
}

function requireSession(input: Record<string, unknown>): string {
	const s = String(input.session ?? "").trim();
	if (!s) throw new Error("A `session` name is required (use tmux_list_sessions to see them).");
	return s;
}

export const TMUX_TOOLS: ToolDef[] = [
	{
		name: "tmux_list_sessions",
		tier: "connector",
		connector: "tmux",
		scope: "read",
		mutates: false,
		description:
			"List every live tmux session on the connected machine (name, window count, whether it's attached, and the command running in its active pane). Use this first to discover which session to read or drive.",
		jsonSchema: { type: "object", properties: {} },
		handler: async (ctx) => {
			const r = await resolveRunner(ctx);
			if ("error" in r) return { content: r.error, success: false };
			const res = await callRunner<{ sessions?: unknown[] }>(r.conn, "/tmux/list", {}, { timeoutMs: READ_TIMEOUT_MS });
			return { content: JSON.stringify(res.sessions ?? [], null, 2), success: true };
		},
	},
	{
		name: "tmux_capture_pane",
		tier: "connector",
		connector: "tmux",
		scope: "read",
		mutates: false,
		description:
			"Read the current output of a tmux session's active pane (ANSI-stripped, with scrollback). Use this to see what a shell, build, server, or CLI is showing right now.",
		jsonSchema: {
			type: "object",
			properties: {
				session: { type: "string", description: "The tmux session name (from tmux_list_sessions)." },
				lines: { type: "number", description: "How many lines of scrollback to include (default 200, max 2000)." },
			},
			required: ["session"],
		},
		handler: async (ctx, input) => {
			const r = await resolveRunner(ctx);
			if ("error" in r) return { content: r.error, success: false };
			const session = requireSession(input);
			const res = await callRunner<{ pane?: string }>(
				r.conn,
				"/tmux/capture",
				{ session, lines: input.lines },
				{ timeoutMs: READ_TIMEOUT_MS },
			);
			return { content: res.pane ?? "", success: true };
		},
	},
	{
		name: "tmux_run_command",
		tier: "connector",
		connector: "tmux",
		scope: "write",
		mutates: true,
		description:
			"Type a command line into a tmux session's active pane and press Enter — for shell commands, git, build/test runs, etc. WRITE: runs on the user's machine. Waits until the pane quiesces before returning; result includes `changed` (false means the pane did not react — the CLI may not be ready).",
		jsonSchema: {
			type: "object",
			properties: {
				session: { type: "string", description: "The tmux session name to run the command in." },
				command: { type: "string", description: "The command line to type and execute (sent literally, then Enter)." },
			},
			required: ["session", "command"],
		},
		handler: async (ctx, input) => {
			const r = await resolveRunner(ctx);
			if ("error" in r) return { content: r.error, success: false };
			const session = requireSession(input);
			const command = String(input.command ?? "");
			if (!command.trim()) return { content: "A `command` is required.", success: false };
			const res = await callRunner<{ pane?: string; paneBefore?: string; changed?: boolean; activeCommand?: string | null }>(r.conn, "/tmux/run", { session, command });
			await noteUnmeteredDrive(ctx.env, ctx, { driver: "terminal", target: `tmux:${session}`, activeCommand: res.activeCommand });
			const landed = res.changed === false ? " (pane did not change — the command may not have landed; is the CLI ready?)" : "";
			return { content: (res.pane ?? `Ran in ${session}.`) + landed, success: true };
		},
	},
	{
		name: "tmux_send_keys",
		tier: "connector",
		connector: "tmux",
		scope: "write",
		mutates: true,
		description:
			"Send literal text and/or named keys to a tmux session's active pane WITHOUT auto-pressing Enter — for key-level control: Escape, C-c, arrow keys, or multi-key sequences. WRITE: runs on the user's machine. Waits until the pane quiesces before returning; result includes `changed` (false means the pane did not react — the CLI may not be at its input prompt yet). Keys use tmux names like \"Enter\", \"Escape\", \"C-c\", \"Up\". To send a message to an interactive CLI and submit it (type text + Enter + confirm landed), use `tmux_send_message` instead.",
		jsonSchema: {
			type: "object",
			properties: {
				session: { type: "string", description: "The tmux session name." },
				text: { type: "string", description: "Literal text to type (optional)." },
				keys: { type: "string", description: "Comma-separated named keys sent after the text, e.g. \"Enter\" or \"C-c\" (optional)." },
			},
			required: ["session"],
		},
		handler: async (ctx, input) => {
			const r = await resolveRunner(ctx);
			if ("error" in r) return { content: r.error, success: false };
			const session = requireSession(input);
			const text = input.text != null ? String(input.text) : undefined;
			const keys = String(input.keys ?? "").split(",").map((k) => k.trim()).filter(Boolean);
			if (text == null && keys.length === 0) return { content: "Provide `text` and/or `keys` to send.", success: false };
			const res = await callRunner<{ pane?: string; paneBefore?: string; changed?: boolean; activeCommand?: string | null }>(r.conn, "/tmux/send", { session, text, keys });
			await noteUnmeteredDrive(ctx.env, ctx, { driver: "terminal", target: `tmux:${session}`, activeCommand: res.activeCommand });
			const landed = res.changed === false ? " (pane did not change — the input may not have landed; is the CLI at its input prompt?)" : "";
			return { content: (res.pane ?? `Sent to ${session}.`) + landed, success: true };
		},
	},
	{
		name: "tmux_send_message",
		tier: "connector",
		connector: "tmux",
		scope: "write",
		mutates: true,
		description:
			"Send a message to an interactive CLI running in a tmux session and submit it (types the text, presses Enter, waits for the pane to quiesce, and confirms the input landed). WRITE: runs on the user's machine. Use this — not `tmux_send_keys` — whenever you want to submit a message or command to a running CLI like Claude Code, Codex, or a REPL. Returns `changed: false` with an explicit warning when the pane did not react (CLI not yet at its input prompt — retry after a short wait).",
		jsonSchema: {
			type: "object",
			properties: {
				session: { type: "string", description: "The tmux session name (from tmux_list_sessions)." },
				message: { type: "string", description: "Text to type and submit (sent as-is, then Enter)." },
			},
			required: ["session", "message"],
		},
		handler: async (ctx, input) => {
			const r = await resolveRunner(ctx);
			if ("error" in r) return { content: r.error, success: false };
			const session = requireSession(input);
			const message = String(input.message ?? "");
			if (!message) return { content: "A `message` is required.", success: false };
			// Send the text then Enter as a single atomic operation: the runner handles
			// text + keys in one /tmux/send call and waits for the pane to quiesce (#481).
			const res = await callRunner<{ pane?: string; paneBefore?: string; changed?: boolean; activeCommand?: string | null }>(
				r.conn,
				"/tmux/send",
				{ session, text: message, keys: ["Enter"] },
			);
			await noteUnmeteredDrive(ctx.env, ctx, { driver: "terminal", target: `tmux:${session}`, activeCommand: res.activeCommand });
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
		name: "tmux_new_session",
		tier: "connector",
		connector: "tmux",
		scope: "write",
		mutates: true,
		description:
			"Create a new detached tmux session (optionally running a command in a working directory). WRITE: runs on the user's machine. No-op if a session with that name already exists.",
		jsonSchema: {
			type: "object",
			properties: {
				session: { type: "string", description: "Name for the new session." },
				workDir: { type: "string", description: "Working directory to start in (default home; ~ is expanded)." },
				command: { type: "string", description: "Optional command to run on start (e.g. \"claude\")." },
			},
			required: ["session"],
		},
		handler: async (ctx, input) => {
			const r = await resolveRunner(ctx);
			if ("error" in r) return { content: r.error, success: false };
			const session = requireSession(input);
			const res = await callRunner<{ created?: boolean; existed?: boolean; workDir?: string }>(
				r.conn,
				"/tmux/session",
				{ action: "create", session, workDir: input.workDir, command: input.command },
			);
			if (res.existed) return { content: `Session "${session}" already exists.`, success: true };
			// When a startup command was given, the runner waited for the pane to quiesce before
			// returning (#481), so "ready" is verified rather than assumed.
			const readyNote = input.command ? ` (startup command "${input.command}" ran; pane settled)` : "";
			return { content: `Created tmux session "${session}"${res.workDir ? ` in ${res.workDir}` : ""}${readyNote}.`, success: true };
		},
	},
	{
		name: "tmux_kill_session",
		tier: "connector",
		connector: "tmux",
		scope: "write",
		mutates: true,
		description:
			"Kill a tmux session by name. WRITE: runs on the user's machine. Destroys whatever is running in it — use with care.",
		jsonSchema: {
			type: "object",
			properties: {
				session: { type: "string", description: "The tmux session name to kill." },
			},
			required: ["session"],
		},
		handler: async (ctx, input) => {
			const r = await resolveRunner(ctx);
			if ("error" in r) return { content: r.error, success: false };
			const session = requireSession(input);
			const res = await callRunner<{ killed?: boolean }>(r.conn, "/tmux/session", { action: "kill", session });
			return res.killed
				? { content: `Killed tmux session "${session}".`, success: true }
				: { content: `No tmux session "${session}" to kill.`, success: false };
		},
	},
];
