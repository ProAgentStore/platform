// Secure input / one-time secret handoff for agents (#906)
//
// Agents can request an opaque secure input reference, check status, and inject secrets
// to destinations (tmux/env/stdin) without the plaintext ever being visible to the model,
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
		"Request a secure input to be supplied by the instance owner outside of the chat (e.g., for a Firebase auth code, OTP, or password). This tool does NOT accept the secret itself — only metadata. The user sees a secure-entry prompt in the PAGS console and submits the value there, encrypted at rest. The agent receives only the request ID (opaque reference) and status. Use `secure_input_status` to check if the user has provided the value, and `secure_input_inject` to inject it to a destination (tmux, env, stdin, file) once ready. The value is never visible to the model, chat, or tool results.",
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
				.enum(["tmux", "env", "stdin", "file"])
				.describe(
					"Where this secret will be injected: 'tmux' = send to tmux session prompt, 'env' = environment variable, 'stdin' = stdin of a process, 'file' = ephemeral file (cleaned up after use).",
				),
			one_shot: z.boolean().optional().default(true).describe("If true, the secret is consumed exactly once and deleted. If false, reusable (future feature)."),
			target: z.string().max(128).optional().describe("tmux only: the session the value is for (from tmux_list_sessions). secure_input_inject types into it unless told another."),
			dry_run: z.boolean().optional().describe("Preview what would be created without actually creating the request."),
		},
		async ({ token, instance_id, label, purpose, destination_scope, one_shot, target, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();

			const input = { instance_id, label, purpose, destinationScope: destination_scope, oneShot: one_shot, ...(target ? { target } : {}) };
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
				{ method: "POST", body: JSON.stringify({ label, purpose, destinationScope: destination_scope, oneShot: one_shot, ...(target ? { target } : {}) }) },
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
		"Check the status of a secure input request (metadata only, never the secret value). Returns: 'pending' (waiting for user input), 'ready' (user has submitted, encrypted, waiting to inject), 'consumed' (already injected and deleted), or 'expired' (TTL elapsed). Once a value is stored it also gives `length` (characters), `empty` and `hasLeadingTrailingWhitespace` — enough to tell an empty or truncated submission (or a pasted trailing newline) from a failed delivery, never the value. Use this to poll until ready, then call `secure_input_inject`.",
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
		"Type a ready `tmux` secure input into a tmux session's prompt line and, by default, press Enter — VERIFIED. The platform types it over the same path tmux_send_message uses and checks the value actually appeared on the pane; the value never enters this conversation, the result, or any log. Returns `delivered` (true only when verified on the pane), `submitted`, `consumedValue`, `target`, `status`, `length`, and a `reason` when not delivered. A value that did not land is cleared from the line, NOT submitted, and NOT consumed — it stays ready to retry. Name the session with `target` (tmux_list_sessions) unless the request already named one. A prompt that hides typing (a password prompt) cannot be verified this way. For a FILE destination use tmux_secure_get with the request id as the handle.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly."),
			request_id: z.string().describe("The secure input request ID. Copy it exactly."),
			target: z.string().max(128).optional().describe("The tmux session to type into (from tmux_list_sessions). Required unless secure_input_request named one."),
			submit: z.boolean().optional().describe("Press Enter once the value is verified on the prompt line. Default true — omit for a prompt waiting for the value."),
			dry_run: z.boolean().optional().describe("Preview the injection without typing or consuming anything."),
		},
		async ({ token, instance_id, request_id, target, submit, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();

			const input = { instance_id, request_id, ...(target ? { target } : {}), submit: submit !== false };
			const denied = await requirePermission(safetyFor(token), "runtime", "secure_input_inject", input);
			if (denied) return denied;

			const endpoint = `/v1/instances/${instance_id}/secure-inputs/${request_id}/inject`;
			if (dry_run) return dryRun(safetyFor(token), "secure_input_inject", `type the secure input into ${target ? `tmux session "${target}"` : "the request's tmux session"}${submit === false ? "" : " and press Enter"}`, input, { endpoint, method: "POST" });

			// The platform delivers and verifies (#966). The answer is the verdict — the value is never in it.
			const data = (await authedCall(endpoint, sessionToken, { method: "POST", body: JSON.stringify({ ...(target ? { target } : {}), submit: submit !== false }) }, env)) as { error?: string; delivered?: boolean };
			if (!data.error) await audit(safetyFor(token), { tool: "secure_input_inject", action: data.delivered ? "completed" : "failed", input, result: data });
			return jsonText(data);
		},
	);
}
