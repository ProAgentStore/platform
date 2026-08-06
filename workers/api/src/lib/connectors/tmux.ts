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
import type { ToolDef, RegistryToolCtx } from "./types.js";
import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS, type RunnerConn } from "../runner-client.js";

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
		description:
			"Type a command line into a tmux session's active pane and press Enter — for shell commands, git, build/test runs, etc. WRITE: runs on the user's machine; requires the tmux connector's write consent. Returns the pane right after sending; capture again after a moment to read the result.",
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
			const res = await callRunner<{ pane?: string }>(r.conn, "/tmux/run", { session, command });
			return { content: res.pane ?? `Ran in ${session}.`, success: true };
		},
	},
	{
		name: "tmux_send_keys",
		tier: "connector",
		connector: "tmux",
		scope: "write",
		description:
			"Send literal text and/or named keys to a tmux session's active pane WITHOUT auto-pressing Enter — for answering a running CLI's prompt (e.g. an interactive Claude/Codex session), pressing Escape/Enter, or sending Ctrl keys. WRITE: requires the tmux connector's write consent. Keys use tmux names like \"Enter\", \"Escape\", \"C-c\", \"Up\".",
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
			const res = await callRunner<{ pane?: string }>(r.conn, "/tmux/send", { session, text, keys });
			return { content: res.pane ?? `Sent to ${session}.`, success: true };
		},
	},
	{
		name: "tmux_new_session",
		tier: "connector",
		connector: "tmux",
		scope: "write",
		description:
			"Create a new detached tmux session (optionally running a command in a working directory). WRITE: requires the tmux connector's write consent. No-op if a session with that name already exists.",
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
			return { content: `Created tmux session "${session}"${res.workDir ? ` in ${res.workDir}` : ""}.`, success: true };
		},
	},
	{
		name: "tmux_kill_session",
		tier: "connector",
		connector: "tmux",
		scope: "write",
		description:
			"Kill a tmux session by name. WRITE: requires the tmux connector's write consent. Destroys whatever is running in it — use with care.",
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
