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
import { observeDeviceAuth } from "../engine-reauth-expiry.js";
import { consumeSecureInput, depositSecureInput, restoreConsumedSecureInput } from "../secure-input.js";
import { secureInputLink } from "../console-links.js";
import { runnerUpgradeMessage, runnerUpgradeRefusal } from "../runner-upgrade.js";

/** The CLI release whose runner serves `/secure/read` + `/secure/write` (#918). */
export const SECURE_HANDOFF_MIN_CLI = "0.4.69";

/**
 * A runner error, safe to show the model. The runner never puts the value in an error (coding/
 * secret-file.ts names paths only), and an older runner 404s the endpoint — that becomes the
 * upgrade sentence naming the machine, not a raw "→ 404".
 */
async function handoffRunnerError(ctx: RegistryToolCtx, e: unknown, what: string): Promise<string> {
	const message = e instanceof Error ? e.message : String(e);
	// The secure endpoints never answer 404 themselves, so a 404 is the runner not knowing them.
	if (/→ 404/.test(message)) {
		const facts = { what, minCli: SECURE_HANDOFF_MIN_CLI };
		if (!ctx.instanceId || !ctx.userId) return runnerUpgradeMessage(facts);
		return runnerUpgradeRefusal(ctx.env, ctx.instanceId, ctx.userId, facts).catch(() => runnerUpgradeMessage(facts));
	}
	const body = message.replace(/^Runner \/secure\/(read|write) → \d+: /, "");
	try {
		return String((JSON.parse(body) as { error?: unknown }).error ?? body);
	} catch {
		return body;
	}
}

/**
 * A device-code sign-in typed into the owner's own tmux session is recorded so it can be warned
 * about before its code expires (#890). Best-effort: it never changes what the tool returns.
 */
async function watchForDeviceAuth(ctx: RegistryToolCtx, conn: RunnerConn, session: string, pane: unknown): Promise<void> {
	if (typeof pane !== "string" || !pane) return;
	await observeDeviceAuth(ctx.env, { instanceId: ctx.instanceId, userId: ctx.userId, runnerNode: conn.runnerNode ?? null, session, pane }).catch(() => undefined);
}

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
		untrustedOutput: true,
		description:
			"List every live tmux session on the connected machine (name, window count, whether it's attached, and the command running in its active pane). Use this first to discover which session to read or drive.",
		jsonSchema: { type: "object", properties: {} },
		handler: async (ctx) => {
			const r = await resolveRunner(ctx);
			if ("error" in r) return { content: r.error, success: false };
			const res = await callRunner<{ sessions?: unknown[] }>(r.conn, "/tmux/list", {}, { timeoutMs: READ_TIMEOUT_MS });
			// Session names and the active pane's command line: strings the machine chose, not ones
			// the owner typed here.
			return { content: JSON.stringify(res.sessions ?? [], null, 2), success: true, origin: "the tmux sessions on your machine" };
		},
	},
	{
		name: "tmux_capture_pane",
		tier: "connector",
		connector: "tmux",
		scope: "read",
		mutates: false,
		untrustedOutput: true,
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
			await watchForDeviceAuth(ctx, r.conn, session, res.pane);
			return { content: res.pane ?? "", success: true, origin: `the tmux session "${session}" on your machine` };
		},
	},
	{
		name: "tmux_run_command",
		tier: "connector",
		connector: "tmux",
		scope: "write",
		mutates: true,
		untrustedOutput: true,
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
			await watchForDeviceAuth(ctx, r.conn, session, res.pane);
			// The landed note is the PLATFORM's judgement about the pane, not the pane — it rides in
			// `tail`, outside the fence, or the model reads our diagnosis as terminal output.
			const landed = res.changed === false ? "(pane did not change — the command may not have landed; is the CLI ready?)" : "";
			return { content: res.pane ?? `Ran in ${session}.`, success: true, tail: landed, origin: `the tmux session "${session}" on your machine` };
		},
	},
	{
		name: "tmux_send_keys",
		tier: "connector",
		connector: "tmux",
		scope: "write",
		mutates: true,
		untrustedOutput: true,
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
			await watchForDeviceAuth(ctx, r.conn, session, res.pane);
			const landed = res.changed === false ? "(pane did not change — the input may not have landed; is the CLI at its input prompt?)" : "";
			return { content: res.pane ?? `Sent to ${session}.`, success: true, tail: landed, origin: `the tmux session "${session}" on your machine` };
		},
	},
	{
		name: "tmux_send_message",
		tier: "connector",
		connector: "tmux",
		scope: "write",
		mutates: true,
		untrustedOutput: true,
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
			await watchForDeviceAuth(ctx, r.conn, session, res.pane);
			if (res.changed === false) {
				return {
					content: res.pane ?? "",
					success: false,
					tail: "(pane did not change — message may not have landed; is the CLI at its input prompt? Wait for the prompt and retry.)",
					origin: `the tmux session "${session}" on your machine`,
				};
			}
			return { content: res.pane ?? "Message sent.", success: true, origin: `the tmux session "${session}" on your machine` };
		},
	},
	{
		name: "tmux_new_session",
		tier: "connector",
		connector: "tmux",
		scope: "write",
		mutates: true,
		untrustedOutput: false,
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
	// ── Secret handoff (#918) ──────────────────────────────────────────────────────────────────
	// Machine A's operator PUTs a file into the encrypted secure-input store and gets a handle;
	// machine B's operator GETs that handle into a file. The value moves runner → this Worker →
	// encrypted D1 → this Worker → runner, inside the handlers below: it is never in a tool result,
	// a pane, a shell command or an error, which is why these are not `tmux_run_command` + `cat`.
	{
		name: "tmux_secure_put",
		tier: "connector",
		connector: "tmux",
		scope: "write",
		mutates: true,
		untrustedOutput: false,
		description:
			"Deposit a secret FILE from this machine (e.g. `app/.env.prod`, a key file) into the encrypted secure-input store WITHOUT the value ever entering this conversation. The runner reads the file and the platform encrypts it; you get back only an opaque `handle`. Hand the handle to `tmux_secure_get` on another of the owner's machines (another tmux operator instance) to write it there. One-shot: the first successful get spends it. WRITE: reads a file on the user's machine. Text files up to 64 KiB.",
		jsonSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "File to deposit. Absolute, `~/…`, or relative to the home directory." },
				label: { type: "string", description: "Short name the owner sees in the console, e.g. \"heartfull .env.prod\". Never put the value here." },
				ttl_minutes: { type: "number", description: "How long the handle stays retrievable (default 60, max 1440)." },
			},
			required: ["path", "label"],
		},
		handler: async (ctx, input) => {
			const r = await resolveRunner(ctx);
			if ("error" in r) return { content: r.error, success: false };
			const path = String(input.path ?? "").trim();
			const label = String(input.label ?? "").trim().slice(0, 200);
			if (!path || !label) return { content: "Both `path` and `label` are required.", success: false };
			const ttlMinutes = Math.min(Math.max(Number(input.ttl_minutes) || 60, 1), 1440);
			let read: { path?: string; value?: unknown; bytes?: number };
			try {
				read = await callRunner<{ path?: string; value?: unknown; bytes?: number }>(r.conn, "/secure/read", { path }, { timeoutMs: READ_TIMEOUT_MS });
			} catch (e) {
				return { content: await handoffRunnerError(ctx, e, "the secure file handoff"), success: false };
			}
			if (typeof read.value !== "string" || !read.value) return { content: `The runner returned nothing for ${path}.`, success: false };
			const node = r.conn.runnerNode ?? null;
			const deposit = await depositSecureInput(ctx.env, {
				instanceId: ctx.instanceId as string,
				userId: ctx.userId as string,
				label,
				purpose: `Deposited from ${read.path ?? path}${node ? ` on ${node}` : ""} by tmux_secure_put.`,
				sourceNode: node,
				ttlMs: ttlMinutes * 60_000,
				value: read.value,
			});
			return {
				content: JSON.stringify({
					handle: deposit.id,
					status: "ready",
					bytes: read.bytes ?? null,
					sourceNode: node,
					expiresAt: deposit.expiresAt,
					consoleUrl: secureInputLink(ctx.instanceId as string, deposit.id),
					next: "Call tmux_secure_get with this handle on the destination machine's operator.",
				}),
				success: true,
			};
		},
	},
	{
		name: "tmux_secure_get",
		tier: "connector",
		connector: "tmux",
		scope: "write",
		mutates: true,
		untrustedOutput: false,
		description:
			"Write a secret from the encrypted secure-input store to a FILE on this machine, by the opaque `handle` from `tmux_secure_put` (on any of the owner's operator instances) or a ready `secure_input_request`. The value never enters this conversation: you get back only the path and a byte count. One-shot: the handle is spent by a successful write, and restored if the write fails. Created with mode 600 unless `mode` says otherwise; refuses to replace an existing file unless `overwrite` is true. WRITE: writes a file on the user's machine.",
		jsonSchema: {
			type: "object",
			properties: {
				handle: { type: "string", description: "The handle returned by tmux_secure_put (copy it exactly)." },
				path: { type: "string", description: "Destination file. Absolute, `~/…`, or relative to the home directory. Parent directories are created." },
				mode: { type: "string", description: "Octal file mode, default \"600\". Never group/world-writable or executable." },
				overwrite: { type: "boolean", description: "Replace the file if it already exists (default false)." },
			},
			required: ["handle", "path"],
		},
		handler: async (ctx, input) => {
			const r = await resolveRunner(ctx);
			if ("error" in r) return { content: r.error, success: false };
			const handle = String(input.handle ?? "").trim();
			const path = String(input.path ?? "").trim();
			if (!handle || !path) return { content: "Both `handle` and `path` are required.", success: false };
			const node = r.conn.runnerNode ?? null;
			// Same owner is the authorization: the handle may come from ANOTHER of this owner's
			// instances (machine A's operator), never from anyone else's.
			const value = await consumeSecureInput(ctx.env, handle, null, ctx.userId as string, { consumedNode: node });
			if (value == null) {
				return { content: `Handle ${handle} is not ready: unknown, not yours, already used, or expired. Check it with secure_input_status.`, success: false };
			}
			try {
				const res = await callRunner<{ path?: string; bytes?: number; replaced?: boolean }>(r.conn, "/secure/write", {
					path,
					value,
					mode: input.mode,
					overwrite: input.overwrite === true,
				});
				return {
					content: JSON.stringify({ handle, status: "consumed", path: res.path ?? path, bytes: res.bytes ?? null, replaced: res.replaced === true, node }),
					success: true,
				};
			} catch (e) {
				const restored = await restoreConsumedSecureInput(ctx.env, handle, ctx.userId as string, value).catch(() => false);
				const why = await handoffRunnerError(ctx, e, "the secure file handoff");
				return { content: `${why} ${restored ? "The handle is still ready — fix the destination and retry." : "The handle could not be restored; deposit it again."}`, success: false };
			}
		},
	},
	{
		name: "tmux_kill_session",
		tier: "connector",
		connector: "tmux",
		scope: "write",
		mutates: true,
		untrustedOutput: false,
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
