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
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
			endpoint_url: z.string().describe("HTTP(S) runtime endpoint URL reachable by the MCP worker, e.g. https://runner.example.com. For local browser runners prefer the CLI relay (`pags up`) and instance_runner_node instead of guessing a localhost URL."),
			runner_token: z.string().optional().describe("Bearer token configured on the browser runtime."),
			placement: z.enum(["local", "managed"]).optional().describe("Where the runtime is hosted. Omit for local."),
			capabilities: z.array(z.string()).optional().describe("Runtime capability names this endpoint supports. Omit unless the runner gave you an explicit list."),
			runner_version: z.string().optional().describe("Version string reported by the runner. Omit if unknown."),
			dry_run: z.boolean().optional().describe("Preview the registration without saving it. Use before registering an uncertain endpoint."),
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
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
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
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
			confirm: z.string().optional().describe('Exact confirmation string required for a real unregister: "unregister_instance_runtime". Omit on dry_run.'),
			dry_run: z.boolean().optional().describe("Preview the unregister without removing the runtime endpoint."),
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
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
			type: z.string().describe('Runner task type. Use the exact task type the runtime supports, e.g. "echo" or "browser.open"; do not invent dotted names without checking the runtime docs/status.'),
			input: z.record(z.unknown()).optional().describe("JSON object passed to the runtime task as its input payload. Omit for no input; do not wrap it in another `input` object."),
			requires_approval: z.boolean().optional().describe("When true, the task pauses for approve_instance_task before the runtime performs the approval-gated action."),
			approval_prompt: z.string().optional().describe("Human-readable approval request shown with the waiting task. Use only when requires_approval is true."),
			dry_run: z.boolean().optional().describe("Preview the task creation without enqueueing it on the runtime."),
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
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
			task_id: z.string().describe("Task ID returned by run_instance_task or shown by instance_task_events. Copy it exactly."),
			dry_run: z.boolean().optional().describe("Preview the approval without approving the waiting runtime task."),
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
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
			task_id: z.string().describe("Task ID returned by run_instance_task or shown by instance_task_events. Copy it exactly."),
			confirm: z.string().optional().describe('Exact confirmation string required for a real cancellation: "cancel_instance_task". Omit on dry_run.'),
			dry_run: z.boolean().optional().describe("Preview the cancellation without cancelling the runtime task."),
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
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
			limit: z.coerce.number().int().min(1).max(500).optional().describe("Maximum recent task events to return, 1-500. Omit for 100."),
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
	// ── A run's detail view and its human handoffs (#613) ──────────────────────
	//
	// `instance_board` lists the cards and `instance_task_events` narrates them, but everything
	// a stuck run actually needs — read this one ticket, delete it, answer the value it is
	// waiting for, drive or end the live takeover — was console-only.
	//
	// All of these except the read reach a real browser on a real machine, so they are `runtime`
	// (or `destructive` for the delete), not `write`.

	server.tool(
		"get_instance_task",
		"Read ONE task/ticket on a private instance in full — status, title, description, and whatever the runtime holds for it. Use this after instance_board or instance_task_events names a task you need the detail of. The route prefers the live runner and falls back to the platform's mirrored copy, so a runner-less agent (a pipeline, a config agent) still answers; a reply carrying `runtimeUnavailable: true` is the MIRROR, which can lag the machine.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
			task_id: z.string().describe("Task ID from instance_board, instance_task_events or run_instance_task. Copy it exactly."),
		},
		async ({ token, instance_id, task_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/tasks/${encodeURIComponent(task_id)}`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"delete_instance_task",
		"Delete a ticket from a private instance's board. If it is still running it is stopped on the machine FIRST, and the whole call fails if that stop fails — a card removed while its task kept running would leave a live process with nothing pointing at it. Harsher than cancel_instance_task, which stops the work and leaves the card as a record; use that one unless the card itself should go.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
			task_id: z.string().describe("Task ID from instance_board or instance_task_events. Copy it exactly."),
			confirm: z.string().optional().describe('Exact confirmation string required for a real deletion: "delete_instance_task". Omit on dry_run.'),
			dry_run: z.boolean().optional().describe("Preview the deletion without deleting the ticket."),
		},
		async ({ token, instance_id, task_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, task_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_instance_task", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "delete_instance_task", "delete a board ticket (stopping it first if it is running)", input, {
					endpoint: `/v1/instances/${instance_id}/tasks/${task_id}`,
					method: "DELETE",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "delete_instance_task", confirm, "delete_instance_task", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(`/v1/instances/${instance_id}/tasks/${encodeURIComponent(task_id)}`, sessionToken, { method: "DELETE" }, env);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "delete_instance_task", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"answer_instance_input",
		"Answer a needs_input handoff: an agent paused mid-run because it needs a value it must not invent (work authorization, a notice period, an account detail), and is holding the run open waiting for it. Supply the value and the run continues. The value is saved to the owner's Profile, so this is the owner's own answer and nothing else — never a guess. Find the waiting task with instance_board (a needs_human card) or get_instance_task. A 409 means the takeover session is gone (the runner restarted) and the answer was NOT delivered.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
			task_id: z.string().describe("The paused task's ID, from instance_board or get_instance_task. Copy it exactly."),
			value: z.string().describe("The value the agent asked for, in the owner's own words. Never fabricate one — if the owner has not said it, ask them."),
			dry_run: z.boolean().optional().describe("Preview without delivering the value."),
		},
		async ({ token, instance_id, task_id, value, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, task_id, chars: value.length };
			const denied = await requirePermission(safetyFor(token), "runtime", "answer_instance_input", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "answer_instance_input", "answer a needs_input handoff and let the run continue", input, {
					endpoint: `/v1/instances/${instance_id}/input`,
					method: "POST",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/input`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ taskId: task_id, value }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "answer_instance_input", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"resume_instance_takeover",
		"Resume a run after a human dealt with what it handed off — a captcha solved, a widget operated, a page signed into. The agent re-checks the page and carries on. Answering a needs_input question is a different call (answer_instance_input); this one supplies no value, it just says \"go\".",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
			task_id: z.string().describe("The paused task's ID, from instance_board or get_instance_task. Copy it exactly."),
			dry_run: z.boolean().optional().describe("Preview without resuming the run."),
		},
		async ({ token, instance_id, task_id, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, task_id };
			const denied = await requirePermission(safetyFor(token), "runtime", "resume_instance_takeover", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "resume_instance_takeover", "resume a paused run after a human takeover", input, {
					endpoint: `/v1/instances/${instance_id}/takeover/${task_id}/resume`,
					method: "POST",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/takeover/${encodeURIComponent(task_id)}/resume`,
				sessionToken,
				{ method: "POST" },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "resume_instance_takeover", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"end_instance_takeover",
		"End a human-takeover session, handing the browser back. This does NOT resume the run — use resume_instance_takeover for that. Ending is the one takeover control whose failure is invisible from outside: if it fails the agent still holds the browser and the run is still blocked, so check the result rather than assuming.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
			task_id: z.string().describe("The task whose takeover session should end. Copy it exactly."),
			dry_run: z.boolean().optional().describe("Preview without ending the takeover."),
		},
		async ({ token, instance_id, task_id, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, task_id };
			const denied = await requirePermission(safetyFor(token), "runtime", "end_instance_takeover", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "end_instance_takeover", "end a human-takeover session", input, {
					endpoint: `/v1/instances/${instance_id}/takeover/${task_id}/end`,
					method: "POST",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/takeover/${encodeURIComponent(task_id)}/end`,
				sessionToken,
				{ method: "POST" },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "end_instance_takeover", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"send_instance_takeover_input",
		"Send ONE mouse or keyboard event into a taken-over page (relayed to the real browser over CDP). This is the raw remote-control primitive the console's takeover overlay is built from, and it aims by PIXEL COORDINATE in the page's own space — so it is only usable by a caller that is also reading GET /v1/instances/:id/takeover/:taskId/frame and can see where it is clicking. A caller that cannot see the page should resume_instance_takeover or answer_instance_input instead, or ask the owner to open the console.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
			task_id: z.string().describe("The task whose takeover session receives the event. Copy it exactly."),
			type: z.enum(["move", "down", "up", "click", "scroll", "key", "text"]).describe("Event kind. move/down/up/click/scroll take x and y; text takes text; key takes key."),
			x: z.coerce.number().optional().describe("Page x coordinate in pixels (mouse events)"),
			y: z.coerce.number().optional().describe("Page y coordinate in pixels (mouse events)"),
			delta_x: z.coerce.number().optional().describe("Horizontal wheel delta (scroll)"),
			delta_y: z.coerce.number().optional().describe("Vertical wheel delta (scroll)"),
			text: z.string().optional().describe("Text to insert at the caret (type: text)"),
			key: z.string().optional().describe('Key name for a special key (type: key), e.g. "Enter", "Tab", "Escape", "Backspace", "ArrowDown"'),
			dry_run: z.boolean().optional().describe("Preview without sending the event."),
		},
		async ({ token, instance_id, task_id, type, x, y, delta_x, delta_y, text: insertText, key, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const event: Record<string, unknown> = { type };
			if (x !== undefined) event.x = x;
			if (y !== undefined) event.y = y;
			if (delta_x !== undefined) event.deltaX = delta_x;
			if (delta_y !== undefined) event.deltaY = delta_y;
			if (insertText !== undefined) event.text = insertText;
			if (key !== undefined) event.key = key;
			const input = { instance_id, task_id, type };
			const denied = await requirePermission(safetyFor(token), "runtime", "send_instance_takeover_input", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "send_instance_takeover_input", `send a ${type} event into a taken-over page`, input, {
					endpoint: `/v1/instances/${instance_id}/takeover/${task_id}/input`,
					method: "POST",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/takeover/${encodeURIComponent(task_id)}/input`,
				sessionToken,
				{ method: "POST", body: JSON.stringify(event) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "send_instance_takeover_input", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"start_instance_browser_task",
		"Start a browser task on a private instance: the agent drives the owner's real browser towards an objective, pausing with a needs_human ticket when it hits something it cannot do (a captcha, a sign-in, a value it must not invent). Pro, and it needs a machine running `pags up`. Answers {workflowId, taskId} — follow it with get_instance_task or instance_task_events. Default is a safe rehearsal that walks the flow and stops at the committing action; pass commit=true to let it go through with it.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
			url: z.string().optional().describe("Page to start from. Omit only if the objective names where to go."),
			objective: z.string().optional().describe("What the agent should accomplish, in plain words."),
			commit: z
				.boolean()
				.optional()
				.describe("false (default) = walk the flow but BLOCK the committing action (the purchase, the submit, the send) — a safe rehearsal. true = let it commit for real."),
			dry_run: z.boolean().optional().describe("Preview without starting the task at all."),
		},
		async ({ token, instance_id, url, objective, commit, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const real = commit === true;
			const input = { instance_id, url: url ?? "", objective: objective ?? "", commit: real };
			// Same split as apply_to_job: a rehearsal spends someone's machine (`runtime`), a run
			// allowed to commit does something outward and hard to undo (`destructive`).
			const denied = await requirePermission(safetyFor(token), real ? "destructive" : "runtime", "start_instance_browser_task", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(
					safetyFor(token),
					"start_instance_browser_task",
					real ? "run a browser task that is allowed to COMMIT" : "rehearse a browser task (stops before the committing action)",
					input,
					{ endpoint: `/v1/instances/${instance_id}/browse`, method: "POST" },
				);
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/browse`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ url, objective, dryRun: !real }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "start_instance_browser_task", action: "completed", input, result: data });
			return jsonText(data);
		},
	);
}
