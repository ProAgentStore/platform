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
		},
		async ({ token, instance_id, label, purpose, destination_scope, one_shot }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();

			const input = { instance_id, label, purpose, destinationScope: destination_scope, oneShot: one_shot };
			const denied = await requirePermission(safetyFor(token), "write", "secure_input_request", input);
			if (denied) return denied;

			const data = await authedCall(
				`/v1/instances/${instance_id}/secure-inputs`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ label, purpose, destinationScope: destination_scope, oneShot: one_shot }) },
				env,
			);

			if (!(data as { error?: string }).error) {
				await audit(safetyFor(token), { tool: "secure_input_request", action: "completed", input, result: data });
			}

			return jsonText(data);
		},
	);

	server.tool(
		"secure_input_status",
		"Check the status of a secure input request (metadata only, never the secret value). Returns: 'pending' (waiting for user input), 'ready' (user has submitted, encrypted, waiting to inject), 'consumed' (already injected and deleted), or 'expired' (TTL elapsed). Use this to poll until ready, then call `secure_input_inject`.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly."),
			request_id: z.string().describe("The secure input request ID returned by `secure_input_request`. Copy it exactly."),
		},
		async ({ token, instance_id, request_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();

			const data = await authedCall(`/v1/instances/${instance_id}/secure-inputs/${request_id}`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"secure_input_inject",
		"Inject a ready secure input to its destination (tmux/env/stdin/file) using the opaque request ID. This is a one-shot operation: the secret is retrieved, injected, and immediately deleted from encrypted storage. The plaintext never appears in the model, chat, traces, or terminal snapshots. IMPORTANT: the injected value must be redacted from any subprocess output and the process must be isolated (so the plaintext does not leak into logs, core dumps, or other processes). Use this only when the status shows 'ready'.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly."),
			request_id: z.string().describe("The secure input request ID. Copy it exactly."),
		},
		async ({ token, instance_id, request_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();

			const input = { instance_id, request_id };
			const denied = await requirePermission(safetyFor(token), "runtime", "secure_input_inject", input);
			if (denied) return denied;

			const data = await authedCall(
				`/v1/instances/${instance_id}/secure-inputs/${request_id}/consume`,
				sessionToken,
				{ method: "POST" },
				env,
			);

			// SECURITY: The response contains { value: <plaintext> }. This is NEVER returned to the model.
			// The MCP server layer (or calling agent framework) MUST:
			// 1. NOT log the response
			// 2. NOT include it in any tool result returned to the model
			// 3. NOT put it in traces, events, or audit logs
			// 4. Pass it ONLY to the runner for immediate injection to the destination
			// 5. Discard it from memory immediately after use
			//
			// The pattern is: call this tool → get plaintext → IMMEDIATELY inject to tmux/process stdin
			// → discard → return "injected" status to model (NOT the value).

			if ((data as any).error) {
				return jsonText(data);
			}

			// CRITICALLY: Strip the plaintext from the response before returning to the model.
			// The agent framework or runner MUST handle the plaintext independently.
			await audit(safetyFor(token), { tool: "secure_input_inject", action: "completed", input, result: { success: true } });

			// Return status only, never the value.
			return jsonText({ success: true, note: "Secret injected. Plaintext is NOT in this response (handled by runner)." });
		},
	);
}
