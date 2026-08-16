import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text, type McpEnv } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import { clearFinishedSentence } from "../state-vocabulary.js";
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
/**
 * Resolve a board `jobKey` to the task id the ticket routes take (PAS #137).
 *
 * The two identifiers address different things and nothing maps between them outside the
 * board itself. `set_board_item_status` never needs the mapping — `/board/status` writes a
 * SEPARATE jobKey-keyed overlay table and never touches the task — and the grouping that
 * turns tasks into cards only exists inside the API's `buildInstanceBoard`. So the board is
 * asked, rather than the key being guessed at.
 *
 * (For a ticket the two happen to coincide: `jobKeyForTask` falls back to the task id for
 * anything without a job URL. Relying on that would be a latent bug — it is a fallback in a
 * function whose other branches key by URL, not a contract.)
 *
 * Returns the card's `latestTaskId` — the ticket the card opens. A card that exists only as
 * a status overlay (moved by hand, its runs since cleared) carries an EMPTY `latestTaskId`;
 * that is reported as its own failure rather than sent on as a request to patch task "".
 */
async function resolveJobKeyToTaskId(
	instanceId: string,
	jobKey: string,
	sessionToken: string,
	env: McpEnv,
): Promise<{ taskId: string } | { error: string }> {
	let data: unknown;
	try {
		data = await authedCall(`/v1/instances/${instanceId}/board`, sessionToken, {}, env);
	} catch (e) {
		return { error: `board unavailable: ${e instanceof Error ? e.message : String(e)}` };
	}
	if (isRec(data) && data.error) return { error: String(data.error) };
	const items = isRec(data) && Array.isArray(data.items) ? data.items : [];
	const card = items.find((it) => isRec(it) && it.jobKey === jobKey);
	if (!card || !isRec(card)) return { error: `no board card with jobKey "${jobKey}" — get it from instance_board` };
	const taskId = typeof card.latestTaskId === "string" ? card.latestTaskId : "";
	if (!taskId) {
		return {
			error: `board card "${jobKey}" has no ticket to edit: it exists only as a moved card, or its runs have been cleared`,
		};
	}
	return { taskId };
}

export function registerBoardTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	server.tool(
		"instance_board",
		"Read a private instance's live kanban board — the agent's single work board. Cards are ONE per job (retries of the same job collapse into one card) grouped into the agent's configured columns (e.g. Waiting / Applying / Needs you / Failed / Blocked / Submitted). This is the same board shown in the console; use it to answer \"what's in <column>\" or \"why didn't <job> apply\". Each card carries a short `detail`; a ticket's fuller `reasoning` — the decision/audit its author recorded — is returned only when you pass reasoning:true, and the response counts how many cards have one. `jobCount` and `columns` always describe the WHOLE board and are never reduced; `board` is a PAGE of the cards, so a column with no card in this page is absent rather than empty — read `page.hasMore` and call again with `offset: page.nextOffset` to continue. The card count is bounded by nothing, and reasoning:true makes each card ~4x bigger: the largest measured board (118 cards) served 33 KB by default but 108 KB with reasoning:true, over a calling host's 64 KiB limit, so that read arrives in pages.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			// #574: `create_instance_ticket` accepts `reasoning` and no reader returned it, so the
			// field could be written over MCP and never read back. Opt-in for the reason #569
			// settled on the tool next door — see `groupBoard`.
			reasoning: z.boolean().optional().describe("Include each card's full `reasoning` — the decision/audit the agent recorded when it filed the ticket. Off by default: it is unbounded prose per card and usually longer than `detail`. The response tells you how many cards have one."),
			// #614: re-measured live, the DEFAULT read of the largest board (118 cards) is 33,363 B
			// and fits — #595's `KNOWN_OVER` entry of 128,692 B was the raw API body, which carries
			// `reasoning` for every card, not what this tool serves since #574 made it opt-in. What
			// IS over the limit is `reasoning:true`, at 108,190 B. Paged for that, and because the
			// card count is bounded by nothing. `reasoning:true` gets no separate budget — it makes
			// each card bigger and `fitPage` answers with fewer cards, not a larger reply.
			// `z.coerce` for the reason recorded on `agent_trace.offset`: a host with a cached tool
			// list that predates these arguments sends them as STRINGS, and a bare `z.number()`
			// refuses with -32602 — leaving 66 of this board's 118 cards unreachable while page 1
			// looks perfectly healthy. Measured in production, not anticipated.
			offset: z.coerce.number().int().min(0).optional().describe("Skip this many cards. Pass `page.nextOffset` from the previous reply; omit for the first page."),
			limit: z.coerce.number().int().min(1).optional().describe("Cap the cards returned. The reply is budgeted to fit a host's wire limit regardless, so a large limit is silently reduced rather than refused — `page.count` says what you got."),
		},
		async ({ token, instance_id, reasoning, offset, limit }) => {
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
			return text(groupBoard(data, { reasoning, offset, limit }));
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
		"update_board_ticket",
		"Amend an existing board ticket's WORDING — its title, description and/or reasoning (PAS #137). Address the card by `job_key` from instance_board, the same key set_board_item_status takes. Only the fields you pass change: omit one and it is left alone, pass \"\" to clear it. Everything else about the ticket — its column, its declared action, when it was created — is untouched. To MOVE a card between columns use set_board_item_status; this tool never changes status. Use it to correct a ticket filed with wrong or imprecise wording instead of filing a second, corrected one.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			job_key: z.string().describe("The card's jobKey from instance_board"),
			title: z.string().optional().describe("Replacement title (max 200 chars). Omit to leave it alone."),
			description: z.string().optional().describe("Replacement one-line detail under the title (max 2000 chars). Omit to leave it alone, \"\" to clear it."),
			reasoning: z.string().optional().describe("Replacement 'Why:' block — the decision/audit shown on the card (max 8000 chars). Omit to leave it alone, \"\" to clear it."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, job_key, title, description, reasoning, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();

			// Built from what was PASSED, not from what is non-empty: "" is a real instruction
			// (clear this field) and must survive into the patch, while an omitted field must not
			// appear at all — that difference is the whole merge contract.
			const patch: Record<string, string> = {};
			if (title !== undefined) patch.title = title;
			if (description !== undefined) patch.description = description;
			if (reasoning !== undefined) patch.reasoning = reasoning;
			if (Object.keys(patch).length === 0) {
				return jsonText({ error: "provide at least one of title, description, reasoning" });
			}

			// The audited input names WHICH fields were amended, not their contents: a ticket's
			// prose can be long and is already stored on the card.
			const input = { instance_id, job_key, fields: Object.keys(patch) };
			const denied = await requirePermission(safetyFor(token), "write", "update_board_ticket", input);
			if (denied) return denied;

			// The dry run answers BEFORE the jobKey is resolved, and the endpoint it reports is
			// therefore templated rather than concrete. Resolving first would read better — a
			// preview could then reject an unknown jobKey — but resolution is a board fetch, and a
			// declared dry run reaching the network is exactly what `contract.test.ts` forbids.
			// A preview that quietly makes a request is not a preview.
			if (dry_run) {
				return dryRun(safetyFor(token), "update_board_ticket", "amend board ticket wording", input, {
					endpoint: `/v1/instances/${instance_id}/tasks/<taskId resolved from job_key>`,
					method: "PATCH",
					fields: Object.keys(patch),
				});
			}

			// jobKey addresses a CARD, the ticket routes address a TASK, and only the board maps
			// between them — see resolveJobKeyToTaskId.
			const resolved = await resolveJobKeyToTaskId(instance_id, job_key, sessionToken, env);
			if ("error" in resolved) return jsonText(resolved);
			const data = await authedCall(
				`/v1/instances/${instance_id}/tasks/${resolved.taskId}`,
				sessionToken,
				{ method: "PATCH", body: JSON.stringify(patch) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "update_board_ticket", action: "completed", input, result: data });
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
		// RENDERED from the endpoint's own vocabulary, never typed out (#609). This said
		// "(done/failed/cancelled)" — and `done` is not a task status in any file of this repo.
		clearFinishedSentence(),
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
