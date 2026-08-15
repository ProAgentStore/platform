import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import { groupBoard, type InstanceToolsCtx, isRec } from "./shared.js";

/**
 * The board — the agent's single work surface — its columns, and the per-ticket
 * question-and-answer thread (#150).
 *
 * The board's SHAPE is owned by the API (`lib/board.ts`); this group only proxies it and
 * buckets the flat items into columns (`groupBoard` in `shared.ts`). The thread tools sit
 * here because a ticket is a board card, and because the constraint they carry — the answer
 * is grounded in that one ticket's record and CANNOT act — is a property of the board's
 * approval gate, not of chat.
 */
export function registerBoardTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	server.tool(
		"instance_board",
		"Read a private instance's live kanban board — the agent's single work board. Cards are ONE per job (retries of the same job collapse into one card) grouped into the agent's configured columns (e.g. Waiting / Applying / Needs you / Failed / Blocked / Submitted). This is the same board shown in the console; use it to answer \"what's in <column>\" or \"why didn't <job> apply\". Each card carries a short `detail`; a ticket's fuller `reasoning` — the decision/audit its author recorded — is returned only when you pass reasoning:true, and the response counts how many cards have one.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			// #574: `create_instance_ticket` accepts `reasoning` and no reader returned it, so the
			// field could be written over MCP and never read back. Opt-in for the reason #569
			// settled on the tool next door — see `groupBoard`.
			reasoning: z.boolean().optional().describe("Include each card's full `reasoning` — the decision/audit the agent recorded when it filed the ticket. Off by default: it is unbounded prose per card and usually longer than `detail`. The response tells you how many cards have one."),
		},
		async ({ token, instance_id, reasoning }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			// The API (lib/board.ts) is the single source of the board shape — one card
			// per job, configured columns, human status overrides. Fetch it and group
			// the flat items by column for a readable answer. Surface a real failure
			// instead of returning an empty board (which reads as "no jobs").
			let data: unknown;
			try {
				data = await authedCall(`/v1/instances/${instance_id}/board`, sessionToken, {}, env);
			} catch (e) {
				return jsonText({ error: `board unavailable: ${e instanceof Error ? e.message : String(e)}` });
			}
			if (isRec(data) && data.error) return jsonText({ error: data.error });
			return jsonText(groupBoard(data, { reasoning }));
		},
	);

	server.tool(
		"set_board_item_status",
		"Move a board card to a different column (or reset it to automation by omitting status). Get valid statuses from instance_board / get_agent_board_config.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			job_key: z.string().describe("The card's jobKey from instance_board"),
			status: z.string().optional().describe("Target column/status id. Omit or empty to hand the card back to automation."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, job_key, status, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, job_key, status: status ?? "" };
			const denied = await requirePermission(safetyFor(token), "write", "set_board_item_status", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_board_item_status", "move board card", input, {
					endpoint: `/v1/instances/${instance_id}/board/status`,
					method: "POST",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/board/status`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ jobKey: job_key, status: status ?? "" }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_board_item_status", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"get_instance_board_config",
		"Read a private instance's board configuration: its columns, the preferred view (kanban | list), whether the columns are a per-instance override or the agent's own, and the agent's default columns. Pair with set_instance_board_config to customize the board.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/board-config`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"set_instance_board_config",
		"Customize a private instance's board: replace its columns and/or set the default view (kanban | list). Columns are ordered; each card lands in the first column whose `statuses` include its status, else the column marked `catchAll`. Pass columns:[] (or omit and set view only) to keep columns; the console UI, MCP, and the agent itself all write through here. This is a per-instance override — it does not change the agent template.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			columns: z
				.array(
					z.object({
						id: z.string().describe("Stable column id (also a movable status target)."),
						title: z.string().describe("Column header shown to the user."),
						color: z.string().optional().describe("Hex dot color, e.g. #22c55e."),
						statuses: z.array(z.string()).optional().describe("Task statuses that live in this column."),
						catchAll: z.boolean().optional().describe("Set on ONE column to hold any unmatched status."),
					}),
				)
				.optional()
				.describe("Full ordered column list (replaces the current override). Empty array or null resets to the agent's columns."),
			view: z.enum(["kanban", "list"]).optional().describe("Default view for the console board."),
			reset: z.boolean().optional().describe("Set true to drop the per-instance column override (fall back to the agent's columns)."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, columns, view, reset, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const payload: Record<string, unknown> = {};
			if (reset) payload.columns = null;
			else if (columns !== undefined) payload.columns = columns;
			if (view) payload.view = view;
			const input = { instance_id, columns: reset ? null : columns, view };
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_board_config", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_instance_board_config", "customize instance board", input, {
					endpoint: `/v1/instances/${instance_id}/board-config`,
					method: "PUT",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/board-config`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify(payload) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_instance_board_config", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"hint_instance_task",
		"Attach a hint to a runtime task (guidance the agent reads on its next step, e.g. answering a blocked task's question).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			task_id: z.string(),
			hint: z.string().describe("The guidance text (max 2000 chars)"),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, task_id, hint, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, task_id };
			const denied = await requirePermission(safetyFor(token), "write", "hint_instance_task", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "hint_instance_task", "attach hint to runtime task", input, {
					endpoint: `/v1/instances/${instance_id}/tasks/${task_id}/hint`,
					method: "POST",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/tasks/${task_id}/hint`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ hint }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "hint_instance_task", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	// ── Per-ticket conversation (#150) ─────────────────────────────────────────
	//
	// A supervisor agent could already READ a subordinate's board (instance_board,
	// subordinate_status) but could not QUESTION anything on it — the thread was
	// console-only, so agent review was strictly weaker than human review while the
	// delegation model assumes a supervisor can interrogate what a subordinate did.
	//
	// Both tools are thin proxies onto the SAME routes the console calls, which is what
	// carries the two rules that make the thread trustworthy onto this surface:
	//
	//  • GROUNDED — the answer is built server-side from THIS ticket's record (its
	//    reasoning, its declared action, its activity, including the `act.consequential`
	//    events a run now records) by a model call with NO tools. An unrecorded detail
	//    comes back as "that isn't recorded". A confabulated answer would be worse than no
	//    thread, because it is read as the audit trail — so the constraint is restated in
	//    the payload, where the CALLING model will see it next to the answer it is about
	//    to summarise.
	//  • NO ACTION — neither tool can start, change, approve or run anything. There is no
	//    code path from the thread route to executeTriggerAction, and neither tool accepts
	//    an action argument, so the approval gate gains no free-text bypass. Running a
	//    ticket's declared work stays with approve_instance_task / run_instance_task,
	//    which are separately scoped and audited.

	/** Restated in every payload: the caller is a model, and it is the one at risk of
	 *  smoothing "not recorded" into a plausible account of what happened. */
	const TICKET_GROUNDING_NOTE =
		"Answered only from this ticket's own record — its reasoning, declared action and logged activity. The agent had no tools and could not re-inspect anything, so \"not recorded\" means the detail was never written down: report that as-is, do not infer what probably happened. This thread cannot act; approving the ticket is still the only thing that runs its declared action.";

	server.tool(
		"ticket_thread",
		"Read the question-and-answer thread on ONE board ticket, oldest first (#150). Use it before ask_ticket to see what has already been asked and answered. Get task_id from instance_board (`latestTaskId` on a card). Read-only, and the turns it returns ARE the audit trail — quote them, don't paraphrase them into stronger claims.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			task_id: z.string().describe("The ticket's task id — `latestTaskId` from an instance_board card."),
		},
		async ({ token, instance_id, task_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(
				`/v1/instances/${instance_id}/tasks/${task_id}/thread`,
				sessionToken,
				{},
				env,
			);
			if (isRec(data) && data.error) return jsonText(data);
			const turns = isRec(data) && Array.isArray(data.turns) ? data.turns : [];
			return jsonText({
				turns,
				turnCount: turns.length,
				note: TICKET_GROUNDING_NOTE,
			});
		},
	);

	server.tool(
		"ask_ticket",
		"Ask ONE board ticket a question and get the agent's answer (#150) — \"why did you decide that\", \"what did you actually change\", \"what did you skip\", \"what happens if I approve this\". This is how one agent reviews another's work: the answer is built from THAT ticket's record alone, so the same question on two tickets gets two different answers. It EXPLAINS, it never acts — it cannot start work, change the ticket, or approve it; use approve_instance_task or run_instance_task for that. If the answer says something is not recorded, that is the honest answer: report it, do not fill the gap.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			task_id: z.string().describe("The ticket's task id — `latestTaskId` from an instance_board card."),
			question: z.string().describe("What to ask about this ticket (max 4000 chars)."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, task_id, question, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, task_id };
			// `write`, not read: the question is persisted onto the ticket before the model runs
			// (so a provider failure can't lose it) and the answer spends the owner's tokens.
			// It is NOT `runtime` — nothing on the ticket is executed.
			const denied = await requirePermission(safetyFor(token), "write", "ask_ticket", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "ask_ticket", "ask a ticket about its own record", input, {
					endpoint: `/v1/instances/${instance_id}/tasks/${task_id}/thread`,
					method: "POST",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/tasks/${task_id}/thread`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ message: question }) },
				env,
			);
			if (isRec(data) && data.error) return jsonText(data);
			await audit(safetyFor(token), { tool: "ask_ticket", action: "completed", input, result: data });
			return jsonText({ ...(isRec(data) ? data : {}), note: TICKET_GROUNDING_NOTE });
		},
	);

	server.tool(
		"clear_finished_tasks",
		"Clear all finished (done/failed/cancelled) runtime tasks from a subscribed instance's board.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id };
			const denied = await requirePermission(safetyFor(token), "write", "clear_finished_tasks", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "clear_finished_tasks", "clear finished runtime tasks", input, {
					endpoint: `/v1/instances/${instance_id}/tasks/clear-finished`,
					method: "POST",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/tasks/clear-finished`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({}) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "clear_finished_tasks", action: "completed", input, result: data });
			return jsonText(data);
		},
	);
}
