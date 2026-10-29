// Secure input / one-time secret handoff for agents (#906)
//
// Agents can request an opaque secure input reference, check status, and inject secrets
// to destinations (tmux/env/stdin, or `sudo` — run on the machine with the password on stdin, #1131) without the plaintext ever being visible to the model,
// chat transcript, tool results, or traces. User submits the secret via console UI.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

export function registerSecureInputTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	server.tool(
		"secure_input_request",
		"Request a secure input to be supplied by the instance owner outside of the chat (e.g., for a Firebase auth code, OTP, or password). This tool does NOT accept the secret itself — only metadata. The user sees a secure-entry prompt in the PAGS console and submits the value there, encrypted at rest. The agent receives only the request ID (opaque reference) and status. Use `secure_input_status` to check if the user has provided the value, and `secure_input_inject` to type it into a terminal (tmux) once ready. For a `sudo` password use destination_scope \"sudo\" with `command` (the program and its arguments as an array, e.g. [\"pmset\",\"-a\",\"autorestart\",\"1\"]): the owner is shown that exact command in the console and approves it by submitting the value, and `secure_input_sudo` then runs it with the password on sudo's stdin — never typed into a pane. The command is fixed when the request is created. The value is never visible to the model, chat, or tool results.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly."),
			label: z
				.string()
				.min(1)
				.max(200)
				.describe("Short label for the console UI: 'Firebase auth code', 'Database password', etc."),
			purpose: z
				.string()
				.max(500)
				.optional()
				.describe("Optional description of why this secret is needed. Shown to the user before they enter the value."),
			destination_scope: z
				.enum(["tmux", "env", "stdin", "file", "sudo"])
				.describe(
					"Where this secret will be injected: 'tmux' = send to tmux session prompt, 'env' = environment variable, 'stdin' = stdin of a process, 'file' = ephemeral file (cleaned up after use), 'sudo' = the password for `sudo` on the instance's machine, delivered by secure_input_sudo to the `command` the owner approves (requires `command`).",
				),
			command: z
				.array(z.string().min(1).max(2048))
				.min(1)
				.max(32)
				.optional()
				.describe("sudo only: the program and its arguments, as an array — NOT a shell string and NOT starting with `sudo`: [\"pmset\", \"-a\", \"autorestart\", \"1\"]. The owner sees `sudo -- pmset -a autorestart 1` and approves it with the value; nothing else can be run with that password."),
			one_shot: z.boolean().optional().default(true).describe("If true, the secret is consumed exactly once and deleted. If false, reusable (future feature)."),
			target: z.string().max(128).optional().describe("tmux only: the session the value is for (from tmux_list_sessions). secure_input_inject types into it unless told another."),
			dry_run: z.boolean().optional().describe("Preview what would be created without actually creating the request."),
		},
		async ({ token, instance_id, label, purpose, destination_scope, command, one_shot, target, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();

			const input = { instance_id, label, purpose, destinationScope: destination_scope, oneShot: one_shot, ...(target ? { target } : {}), ...(command ? { command } : {}) };
			const denied = await requirePermission(safetyFor(token), "write", "secure_input_request", input);
			if (denied) return denied;

			if (dry_run) {
				return dryRun(
					safetyFor(token),
					"secure_input_request",
					`create a secure input request for "${label}"`,
					input,
					{ endpoint: `/v1/instances/${instance_id}/secure-inputs`, method: "POST" },
				);
			}

			const data = await authedCall(
				`/v1/instances/${instance_id}/secure-inputs`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ label, purpose, destinationScope: destination_scope, oneShot: one_shot, ...(target ? { target } : {}), ...(command ? { command } : {}) }) },
				env,
			) as { error?: string; id?: string; consoleUrl?: string };

			if (!data.error) {
				await audit(safetyFor(token), { tool: "secure_input_request", action: "completed", input, result: data });
			}

			return jsonText(data);
		},
	);

	server.tool(
		"secure_input_status",
		"Check the status of a secure input request (metadata only, never the secret value). Returns: 'pending' (waiting for user input), 'ready' (user has submitted, encrypted, waiting to inject), 'consumed' (already injected and deleted), or 'expired' (TTL elapsed). Once a value is stored it also gives `length` (characters), `empty` and `hasLeadingTrailingWhitespace` — enough to tell an empty or truncated submission (or a pasted trailing newline) from a failed delivery, never the value. A `sudo` request also shows its `command` (argv) and `commandApproved`. Use this to poll until ready, then call `secure_input_inject` (a tmux terminal) or `secure_input_sudo` (a sudo request).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly."),
			request_id: z.string().describe("The secure input request ID returned by `secure_input_request`. Copy it exactly."),
		},
		async ({ token, instance_id, request_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();

			const input = { instance_id, request_id };
			const denied = await requirePermission(safetyFor(token), "read", "secure_input_status", input);
			if (denied) return denied;

			const data = await authedCall(`/v1/instances/${instance_id}/secure-inputs/${request_id}`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"secure_input_inject",
		"Type a ready `tmux` secure input into a tmux session's (or terminal target's) prompt line and, by default, press Enter — VERIFIED. The value never enters this conversation, the result, or any log. NOT FOR `sudo`: a masked prompt (sudo, su, ssh, gpg) echoes nothing, so typing into it cannot be confirmed — the only check is the prompt's reaction AFTER Enter, a wrong guess has already used one of its three tries, and nothing can be fixed before it is spent. For a sudo password create the request with destination_scope \"sudo\" and a `command`, then call `secure_input_sudo`, which runs the owner-approved command with the password on sudo's stdin and never types. Two ways of verifying, chosen from the pane before anything is consumed: ECHO — the value must appear on the pane; one that did not land is cleared from the line, NOT submitted, and NOT consumed (it stays ready to retry). OUTCOME — when the pane ends at a password/passphrase prompt, which hides what is typed: the value is typed and submitted, and the prompt must move on with no re-prompt and no 'Permission denied' / 'Sorry, try again' within a few seconds. A rejected password WAS submitted, so it is consumed, the prompt gets C-c, and `reason` says so. Returns `delivered`, `verifiedBy` (which of the two checks above judged it), `submitted`, `consumedValue`, `target`, `status`, `length`, and a `reason` when not delivered. Name the target with `target` — a tmux session from tmux_list_sessions, or a terminal target like `tmux:main` / `kitty:3` / `iterm2:1:1:1` from terminal_list_targets (iTerm2 needs a runner that sends its keys, #1144) — unless the request already named one. For a FILE destination use tmux_secure_get with the request id as the handle.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly."),
			request_id: z.string().describe("The secure input request ID. Copy it exactly."),
			target: z.string().max(128).optional().describe("The tmux session (tmux_list_sessions) or terminal target such as `tmux:main` or `kitty:3` (terminal_list_targets) to type into. Required unless secure_input_request named one."),
			submit: z.boolean().optional().describe("Press Enter once the value is verified on the prompt line. Default true — omit for a prompt waiting for the value. A password prompt requires it."),
			hidden_prompt: z.boolean().optional().describe("true: the pane must END at a password/passphrase prompt (refused, nothing consumed, if not) and delivery is verified by the prompt's outcome. false: verify by echo only. Omit to detect from the pane."),
			dry_run: z.boolean().optional().describe("Preview the injection without typing or consuming anything."),
		},
		async ({ token, instance_id, request_id, target, submit, hidden_prompt, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();

			const input = { instance_id, request_id, ...(target ? { target } : {}), submit: submit !== false, ...(hidden_prompt === undefined ? {} : { hidden_prompt }) };
			const denied = await requirePermission(safetyFor(token), "runtime", "secure_input_inject", input);
			if (denied) return denied;

			const endpoint = `/v1/instances/${instance_id}/secure-inputs/${request_id}/inject`;
			if (dry_run) return dryRun(safetyFor(token), "secure_input_inject", `type the secure input into ${target ? `"${target}"` : "the request's tmux session"}${submit === false ? "" : " and press Enter"}${hidden_prompt ? ", verified as a password prompt" : ""}`, input, { endpoint, method: "POST" });

			// The platform delivers and verifies (#966, #1140). The answer is the verdict — the value is never in it.
			const data = (await authedCall(endpoint, sessionToken, { method: "POST", body: JSON.stringify({ ...(target ? { target } : {}), submit: submit !== false, ...(hidden_prompt === undefined ? {} : { hiddenPrompt: hidden_prompt }) }) }, env)) as { error?: string; delivered?: boolean };
			if (!data.error) await audit(safetyFor(token), { tool: "secure_input_inject", action: data.delivered ? "completed" : "failed", input, result: data });
			return jsonText(data);
		},
	);
	// Runs the request's OWNER-APPROVED command under `sudo -S -p '' --` on the instance's machine with the stored password on sudo's stdin (#1131).
	// `dry_run` is offered and is a pure preview: it names what would run without touching the network, the runner or the stored value.
	server.tool(
		"secure_input_sudo",
		"Run the command a `sudo` secure input was created for — as root, on the instance's machine, with the owner's stored password delivered to sudo's STDIN by the runner. NEVER typed into a terminal: the value is not in any pane, scrollback, process argument, environment variable, log or this result. Use it for a request made with secure_input_request destination_scope \"sudo\" and a `command`, once secure_input_status says `ready` and `commandApproved` — the owner approved that exact command in the console by submitting the password. This tool takes no command: only the approved one can run, and a password cannot be pointed at anything else. Success is sudo's EXIT CODE: `delivered:true` only when it exits 0, and only then is the password spent. Any other outcome — a wrong password, a command sudo's policy does not allow, a timeout, a runner that cannot be reached or is too old — returns `delivered:false` with `reason` (sudo's own words, the password cut out), `exitCode`, the command's bounded output (`stdout` and `stderr`), and leaves the request `ready`. It is NEVER retried automatically, because each attempt can use up one of sudo's three tries; call it again only after reading the reason (a wrong password needs a NEW request with the right one). For a terminal prompt use secure_input_inject instead; for a file, tmux_secure_get. Returns `delivered`, `reason`, `consumedValue`, `status`, `command`, `commandLine`, `exitCode`, `timedOut`, `stdout`, `stderr`, `length`.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly."),
			request_id: z.string().describe("The secure input request ID from secure_input_request (a `sudo` request that is `ready` and approved). Copy it exactly."),
			dry_run: z.boolean().optional().describe("Preview what would run without running anything or touching the stored password."),
		},
		async ({ token, instance_id, request_id, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();

			const input = { instance_id, request_id };
			const denied = await requirePermission(safetyFor(token), "runtime", "secure_input_sudo", input);
			if (denied) return denied;

			const endpoint = `/v1/instances/${instance_id}/secure-inputs/${request_id}/sudo`;
			if (dry_run) return dryRun(safetyFor(token), "secure_input_sudo", "run the request's owner-approved command under sudo with the stored password on stdin", input, { endpoint, method: "POST" });

			// The platform claims the password, the runner runs sudo, and the exit code is the verdict. The value is never in the answer.
			const data = (await authedCall(endpoint, sessionToken, { method: "POST", body: JSON.stringify({}) }, env)) as { error?: string; delivered?: boolean };
			if (!data.error) await audit(safetyFor(token), { tool: "secure_input_sudo", action: data.delivered ? "completed" : "failed", input, result: data });
			return jsonText(data);
		},
	);
}
