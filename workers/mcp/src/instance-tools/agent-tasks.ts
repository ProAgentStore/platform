import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * The agent's OWN task list (#337, gap group #613) — durable state in the instance's Durable
 * Object that is rendered into its system prompt every turn.
 *
 * ── Not the board. This is the distinction the API paid for with its route name
 *
 * `/v1/instances/:id/agent-tasks` is deliberately NOT `/tasks`: that one is the runtime board
 * (`instance_runtime_tasks`), a different store with a different lifecycle, reached here by
 * `get_instance_task` / `run_instance_task` / `delete_instance_task`. A board ticket is one
 * unit of work a runner executes and finishes. A task here is a STANDING instruction the agent
 * carries — it influences behaviour by being in the prompt, not by being run — so deleting one
 * changes what the agent will do next turn, and creating one is closer to writing a rule than
 * to queueing a job.
 *
 * ── Provenance moves one way only
 *
 * `assignedBy` records who put a task there: `self` when the agent's own `create_task` wrote it
 * straight to DO storage, `trigger` for a webhook, `user` for everything that arrives through
 * these owner-authenticated routes. An OWNER EDIT re-stamps it `user` — the same rule memory's
 * `(user-set)` marker follows, and the reason is the same: nothing on this path can launder a
 * self-assigned task into looking like one a human vouched for, and the agent's own tool never
 * speaks HTTP so it can never move it the other way.
 *
 * ── Two bounds worth knowing before writing one
 *
 * A hard ceiling of 100 tasks per agent (the 101st create is refused, 409), and a staleness
 * rule: a task nothing has touched for 30 days stops being INJECTED into the prompt but is
 * never deleted — any edit brings it back. `list_agent_tasks` returns both numbers in `limits`,
 * so a caller never has to guess which of the two is why an agent is ignoring a task.
 */
export function registerAgentTaskTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	server.tool(
		"list_agent_tasks",
		"The standing tasks an instance carries in its own task store — the ones injected into its system prompt every turn, NOT the runtime board (for that use instance_board or get_instance_task). Returns each task with `status`, `assignedBy` (`user`, `self`, `trigger`) and timestamps, plus `limits`: `max` tasks an agent may hold, how many are `injected` into one prompt, and the `staleDays` after which an untouched task stops being injected while staying in the store. Read this before concluding an agent is ignoring an instruction — a stale or unlisted task is the usual answer.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/agent-tasks`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"create_agent_task",
		"Add a standing task to an instance's own task store, as the OWNER. It goes in as `status: pending`, `assignedBy: user`, and is rendered into the agent's system prompt from the next turn — so this writes a durable instruction, not a job to run (for work a runner should execute, use run_instance_task). Title is capped at 200 characters and description at 2000, both truncated rather than refused. The 101st task on an agent is refused with a 409: the ceiling is what stands between an agent keeping a list and an agent accumulating work nothing bounds.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
			title: z.string().describe("What the task is, in one line (max 200 chars; longer is truncated)."),
			description: z.string().optional().describe("The detail the agent should carry with it (max 2000 chars; longer is truncated)."),
			dry_run: z.boolean().optional().describe("Preview without creating the task."),
		},
		async ({ token, instance_id, title, description, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, title, chars: (description ?? "").length };
			// `write`: a standing task changes what the agent does on every later turn, so a
			// read-only session must not be able to add one. Not `runtime` — nothing runs.
			const denied = await requirePermission(safetyFor(token), "write", "create_agent_task", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "create_agent_task", "add a standing task to this agent's prompt", input, {
					endpoint: `/v1/instances/${instance_id}/agent-tasks`,
					method: "POST",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/agent-tasks`,
				sessionToken,
				// `assignedBy` is deliberately NOT sent: the route treats only the literal
				// "trigger" as special and defaults everything else to "user", which is the
				// honest record for a call made with the owner's session.
				{ method: "POST", body: JSON.stringify(description === undefined ? { title } : { title, description }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "create_agent_task", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"update_agent_task",
		"Edit one standing task — its title, description, or `status`. Only the fields you name change. Two things happen that a caller should expect: the task is re-stamped `assignedBy: user` (an owner who edits a task has taken it on, and provenance may only move agent → owner), and `updatedAt` is refreshed, which brings a task back into the prompt if staleness had dropped it. Marking one `complete` is how it stops influencing the agent without being deleted.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
			task_id: z.string().describe("Task id from list_agent_tasks. Copy it exactly — this is a standing task, not a board ticket."),
			title: z.string().optional().describe("New title (max 200 chars)."),
			description: z.string().optional().describe("New description (max 2000 chars)."),
			status: z.enum(["pending", "in_progress", "blocked", "complete"]).optional().describe("New status. `complete` retires it from the prompt without deleting it."),
			dry_run: z.boolean().optional().describe("Preview without editing the task."),
		},
		async ({ token, instance_id, task_id, title, description, status, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const patch: Record<string, unknown> = {};
			if (title !== undefined) patch.title = title;
			if (description !== undefined) patch.description = description;
			if (status !== undefined) patch.status = status;
			const fields = Object.keys(patch);
			// The DO merges whatever it is sent over the existing task, so an empty body is a
			// no-op that would still re-stamp `assignedBy` and refresh `updatedAt` — i.e. it
			// would quietly change provenance and un-stale a task nobody meant to touch.
			if (fields.length === 0) {
				return jsonText({ error: "nothing to update — name a title, description or status" });
			}
			const input = { instance_id, task_id, fields };
			const denied = await requirePermission(safetyFor(token), "write", "update_agent_task", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "update_agent_task", "edit a standing task (and re-stamp it as the owner's)", input, {
					endpoint: `/v1/instances/${instance_id}/agent-tasks/${task_id}`,
					method: "PUT",
					fields,
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/agent-tasks/${encodeURIComponent(task_id)}`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify(patch) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "update_agent_task", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"delete_agent_task",
		"Remove a standing task from an instance's task store for good. There is no undo and no archive: the task stops being in the agent's prompt and its text is gone. If the intent is \"the agent should stop acting on this\" rather than \"this should never have existed\", update_agent_task with `status: complete` does that and keeps the record. A task id that is already gone answers 404 rather than a blanket success, so a stale prompt entry cannot survive a delete that appeared to work.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Private instance ID or slug from my_instances. Copy it exactly; this is not the public agent_id from list_agents."),
			task_id: z.string().describe("Task id from list_agent_tasks. Copy it exactly — this is a standing task, not a board ticket."),
			confirm: z.string().optional().describe('Exact confirmation string required for a real deletion: "delete_agent_task". Omit on dry_run.'),
			dry_run: z.boolean().optional().describe("Preview without deleting the task."),
		},
		async ({ token, instance_id, task_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, task_id };
			// `destructive` + confirm, matching `delete_instance_memory`: both delete durable DO
			// state that shapes the agent's prompt, and neither can be recovered by re-reading.
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_agent_task", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "delete_agent_task", "delete a standing task from this agent's prompt", input, {
					endpoint: `/v1/instances/${instance_id}/agent-tasks/${task_id}`,
					method: "DELETE",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "delete_agent_task", confirm, "delete_agent_task", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(
				`/v1/instances/${instance_id}/agent-tasks/${encodeURIComponent(task_id)}`,
				sessionToken,
				{ method: "DELETE" },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "delete_agent_task", action: "completed", input, result: data });
			return jsonText(data);
		},
	);
}
