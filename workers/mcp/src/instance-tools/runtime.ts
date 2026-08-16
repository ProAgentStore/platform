import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * The local browser runtime + its task queue: registering the machine running `pags up`,
 * asking whether it is there, and creating / approving / cancelling the work it runs.
 *
 * These are the `runtime` scope's home. The scope means "this spends or drives something
 * outside the platform" — a task here reaches a real browser on a real machine — which is
 * why it is separate from `write`, and why unregistering or cancelling is `destructive`.
 */
export function registerRuntimeTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	server.tool(
		"register_instance_runtime",
		"Register a local or managed ProAgentStore browser runtime for one of your private instances. Use this before run_instance_task for browser-capable agents.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			endpoint_url: z.string().describe("Runtime endpoint URL. Use localhost for a local runner you started yourself."),
			runner_token: z.string().optional().describe("Bearer token configured on the browser runtime."),
			placement: z.enum(["local", "managed"]).optional(),
			capabilities: z.array(z.string()).optional(),
			runner_version: z.string().optional(),
			dry_run: z.boolean().optional(),
		},
		async ({
			token,
			instance_id,
			endpoint_url,
			runner_token,
			placement,
			capabilities,
			runner_version,
			dry_run,
		}) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = {
				instance_id,
				endpoint_url,
				runner_token,
				placement: placement || "local",
				capabilities: capabilities || [],
				runner_version: runner_version || "",
			};
			const denied = await requirePermission(safetyFor(token), "runtime", "register_instance_runtime", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "register_instance_runtime", "register instance runtime endpoint", input, {
					endpoint: `/v1/instances/${instance_id}/runtime`,
					method: "POST",
					body: { ...input, runner_token: runner_token ? "[provided]" : undefined },
				});
			}
			const data = (await authedCall(
				`/v1/instances/${instance_id}/runtime`,
				sessionToken,
				{
					method: "POST",
					body: JSON.stringify({
						endpointUrl: endpoint_url,
						token: runner_token,
						placement: placement || "local",
						capabilities: capabilities || [],
						runnerVersion: runner_version || "",
					}),
				},
				env,
			)) as { runtime?: unknown; error?: string };
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "register_instance_runtime", action: "completed", input: { ...input, runner_token: runner_token ? "[provided]" : undefined }, result: data.runtime });
			return data.error
				? text(`Error: ${data.error}`)
				: text(`Runtime registered for ${instance_id}.\n${JSON.stringify(data.runtime)}`);
		},
	);

	server.tool(
		"instance_runtime_status",
		"Check the registered local or managed browser runtime for one of your private instances.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			probe: z.boolean().optional().describe("When true, PAGS calls the browser runtime /health and /capabilities endpoints."),
		},
		async ({ token, instance_id, probe }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const path = probe
				? `/v1/instances/${instance_id}/runtime/status`
				: `/v1/instances/${instance_id}/runtime`;
			const data = await authedCall(path, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	// ── Which MACHINE an instance runs on (#671) ──
	//
	// The console can read and set this; MCP could do neither. So an instance set up entirely over
	// the connector auto-registered against whichever node answered first, with no way to see that
	// choice being made or to correct it — and a repo added as a LOCAL PATH on the wrong machine is
	// a wrong checkout, not a slower one. `instance_runtime_status` answers for one instance and
	// cannot list the alternatives; `coding_diagnostics` reports the node read-only, and only after
	// something has already been assigned.
	//
	// Two reads rather than one, because they answer different questions and #531 is the reason the
	// console shows both: `list_runner_nodes` is the PLATFORM view (every machine, across every
	// agent, "is a socket open here"), while `instance_runner_node` is the ROUTING view for one
	// instance ("where would this agent's calls actually go"). A machine can be online for another
	// agent while this one has never attached to it, which is why `nodesDetail` carries `connected`
	// (this agent's own socket) beside `nodeOnline` (the machine is up at all). Collapsing them
	// would recreate the confusion the console had to be taught to draw apart.
	//
	// The pin names a HOSTNAME, and a hostname moves under a machine (#379) — so `resolvedNode`
	// says where the pin actually lands when the name it holds is dead. A reader that ignores it
	// will report a working agent as offline.

	server.tool(
		"list_runner_nodes",
		"List every machine of yours running a ProAgentStore CLI (`pags up`), across ALL your agents, with whether each is connected right now. This is the platform view — use it to see what a machine could be pinned to. `connected` is whether a relay socket is open, not whether any particular agent is routed there; for one agent's actual routing use instance_runner_node.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			return jsonText(await authedCall("/v1/terminals/nodes", sessionToken, {}, env));
		},
	);

	server.tool(
		"instance_runner_node",
		"Read which machine ONE instance is pinned to, and which machines it could be pinned to. `runnerNode` is the pin (null means unpinned — calls go to whichever machine holds a live socket). `nodesDetail` reports two different facts per machine: `connected` is whether THIS agent has a socket open there, `nodeOnline` is whether the machine is up for any agent — a machine can be online while this agent has never attached to it. `resolvedNode` is where the pin actually lands when the pinned hostname has changed under the machine; when it is set, the agent is working and the pin's name is merely stale.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID or slug"),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			return jsonText(await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/runner-node`, sessionToken, {}, env));
		},
	);

	server.tool(
		"set_instance_runner_node",
		'Pin one instance to a specific machine, so its runner calls (chat tools, apply, coding) route there. Pass an empty `runner_node` to CLEAR the pin and let it route to whichever machine holds a live socket. Read instance_runner_node first: pinning to a name no machine currently answers to makes the agent unreachable rather than slower, and the name must be one the machine registered under. Applies to any agent with a runtime, not only coding agents.',
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID or slug"),
			runner_node: z.string().describe("Machine (node) name to pin to, from instance_runner_node's `nodes`. Empty string clears the pin."),
			dry_run: z.boolean().optional().describe("Report the change that would be made without making it."),
		},
		async ({ token, instance_id, runner_node, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, runner_node };
			// `write`, not `runtime`: this changes where calls are ROUTED, it does not itself drive
			// anything outside the platform. The scope that spends is still the one on the tools
			// that run work on the machine this names.
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_runner_node", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_instance_runner_node", runner_node ? `pin ${instance_id} to ${runner_node}` : `clear the runner-node pin on ${instance_id}`, input, {
					endpoint: `/v1/instances/${instance_id}/runner-node`,
					method: "PUT",
					body: { runnerNode: runner_node },
				});
			}
			// The write goes through the same route the console uses, which records the change to
			// the trace in `lib/runner-node-pin.ts` (#533) — deliberately not reimplemented here,
			// because a pin changed without an audit entry is one nobody can explain afterwards.
			const data = (await authedCall(
				`/v1/instances/${encodeURIComponent(instance_id)}/runner-node`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify({ runnerNode: runner_node }) },
				env,
			)) as { runnerNode?: string | null; error?: string };
			if (!data.error) await audit(safetyFor(token), { tool: "set_instance_runner_node", action: "completed", input, result: data });
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"unregister_instance_runtime",
		"Remove the registered runtime endpoint for one of your private instances.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			confirm: z.string().optional().describe('Must be "unregister_instance_runtime" to remove a runtime endpoint.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "unregister_instance_runtime", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "unregister_instance_runtime", "remove instance runtime endpoint", input, {
					endpoint: `/v1/instances/${instance_id}/runtime`,
					method: "DELETE",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "unregister_instance_runtime", confirm, "unregister_instance_runtime", input);
			if (unconfirmed) return unconfirmed;
			const data = (await authedCall(
				`/v1/instances/${instance_id}/runtime`,
				sessionToken,
				{ method: "DELETE" },
				env,
			)) as { success?: boolean; error?: string };
			if (data.success) await audit(safetyFor(token), { tool: "unregister_instance_runtime", action: "completed", input });
			return text(data.success ? "Runtime unregistered." : `Error: ${data.error || "unregister failed"}`);
		},
	);

	server.tool(
		"run_instance_task",
		"Create a task on the registered local or managed browser runtime for a private instance. The PAGS brain stays in control; the local ProAgentStore runner executes browser capabilities through the relay.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			type: z.string().describe("Runner task type, e.g. echo or browser.open."),
			input: z.record(z.unknown()).optional(),
			requires_approval: z.boolean().optional(),
			approval_prompt: z.string().optional(),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, type, input, requires_approval, approval_prompt, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const toolInput = { instance_id, type, input: input || {}, requires_approval, approval_prompt };
			const denied = await requirePermission(safetyFor(token), "runtime", "run_instance_task", toolInput);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "run_instance_task", "create browser runtime task", toolInput, {
					endpoint: `/v1/instances/${instance_id}/tasks`,
					method: "POST",
					type,
					requiresApproval: requires_approval,
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/tasks`,
				sessionToken,
				{
					method: "POST",
					body: JSON.stringify({
						type,
						input: input || {},
						requiresApproval: requires_approval,
						approvalPrompt: approval_prompt,
					}),
				},
				env,
			);
			await audit(safetyFor(token), { tool: "run_instance_task", action: "completed", input: toolInput, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"approve_instance_task",
		"Approve a browser runtime task waiting for human approval.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			task_id: z.string(),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, task_id, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, task_id };
			const denied = await requirePermission(safetyFor(token), "runtime", "approve_instance_task", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "approve_instance_task", "approve browser runtime task", input, {
					endpoint: `/v1/instances/${instance_id}/tasks/${task_id}/approve`,
					method: "POST",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/tasks/${task_id}/approve`,
				sessionToken,
				{ method: "POST" },
				env,
			);
			await audit(safetyFor(token), { tool: "approve_instance_task", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"cancel_instance_task",
		"Cancel a task on the registered local or managed browser runtime for a private instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			task_id: z.string(),
			confirm: z.string().optional().describe('Must be "cancel_instance_task" to cancel a browser runtime task.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, task_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, task_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "cancel_instance_task", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "cancel_instance_task", "cancel browser runtime task", input, {
					endpoint: `/v1/instances/${instance_id}/tasks/${task_id}/cancel`,
					method: "POST",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "cancel_instance_task", confirm, "cancel_instance_task", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(
				`/v1/instances/${instance_id}/tasks/${task_id}/cancel`,
				sessionToken,
				{ method: "POST" },
				env,
			);
			await audit(safetyFor(token), { tool: "cancel_instance_task", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"instance_task_events",
		"Read recent events from a private instance's registered browser runtime.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			limit: z.number().int().min(1).max(500).optional(),
		},
		async ({ token, instance_id, limit }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(
				`/v1/instances/${instance_id}/task-events?limit=${limit || 100}`,
				sessionToken,
				{},
				env,
			);
			return jsonText(data);
		},
	);
}
