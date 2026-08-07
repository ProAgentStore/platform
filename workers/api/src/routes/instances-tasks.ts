import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { requireUser } from "../lib/auth.js";
import {
	boardConfigForInstance,
	buildInstanceBoard,
	clearFinishedBoardItems,
	columnsForInstance,
	setBoardItemStatus,
	setInstanceBoardConfig,
} from "../lib/board.js";
import type { BoardColumn } from "../lib/agent-capabilities.js";
import { buildTicketAction, isRunnableStatus, readTicketAction, validateTicketAction } from "../lib/actionable-ticket.js";
import { logEvent } from "../lib/events.js";
import {
	MAX_TICKET_ANSWER_CHARS,
	TICKET_ANSWER_EVENT,
	TICKET_QUESTION_EVENT,
	buildTicketChatMessages,
	normalizeTicketQuestion,
	ticketThreadFromEvents,
} from "../lib/ticket-chat.js";
import { executeTriggerAction } from "../lib/triggers.js";
import { runUserWorkersAi } from "../lib/user-ai.js";
import { readInstanceConfig } from "./instances-apply.js";
import {
	callRuntime,
	clearFinishedRuntimeTasks,
	deleteMirroredRuntimeTask,
	getLiveRuntime,
	getRuntime,
	isRecord,
	mirrorRuntimeEvent,
	mirrorRuntimeEvents,
	mirrorRuntimeTask,
	mirrorRuntimeTasks,
	mirrorTaskLifecycleEvents,
	mirroredRuntimeEvents,
	mirroredRuntimeTask,
	mirroredRuntimeTasks,
	mirroredTaskEvents,
	normalizeRunnerTaskBody,
	requireLiveRuntime,
	requireOwnedInstance,
	runtimeJson,
	runtimeSetupTask,
	runtimeSetupTaskId,
	runtimeStatus,
	syntheticEventsFromTasks,
	updateRuntimeStatus,
} from "./instances-runtime.js";
import type { Env } from "../types.js";

/**
 * The work board and everything that puts a card on it (#305) — runner tasks, board layout,
 * board status overrides, board tickets (including the actionable ones), the per-ticket
 * conversation, and the task-event feed.
 *
 * WHY THIS IS ONE MODULE. These seventeen routes share one substrate that nothing else on the
 * instance surface touches: `instance_runtime_tasks`, the durable D1 MIRROR of the runner's task
 * list. Every one of them either reads the mirror, writes it, or reconciles it against a live
 * runner — which is also why the same two decisions (serve the mirror stale-while-revalidate;
 * dispatch at the LIVE node rather than the stale default row) recur across them. Splitting the
 * board from the tickets would put both halves of that reconciliation in different files.
 *
 * WHAT HOLDS THE BOUNDARY. `instances.contract.test.ts` mounts this function on a bare Hono and
 * asserts it registers exactly these routes and no others, and drives every one of them with a
 * session that owns nothing to derive that each still refuses. A route drifting into or out of
 * this module, or losing its `user_id` scoping, fails there rather than in production.
 */
export function registerTaskRoutes(router: Hono<{ Bindings: Env }>): void {
	/** List tasks on my registered runtime. */
	router.get("/:instanceId/tasks", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const runtime = await getRuntime(c.env, instanceId, session.uid);
		if (!runtime) {
			const tasks = await mirroredRuntimeTasks(c.env, instanceId, session.uid);
			const hasRuntimeSetupTask = tasks.some(
				(task) => isRecord(task) && task.id === runtimeSetupTaskId(instanceId),
			);
			if (!hasRuntimeSetupTask) tasks.unshift(runtimeSetupTask(instanceId));
			return c.json({
				tasks,
				runtimeUnavailable: true,
				error: "Runtime not registered",
			});
		}
		// Stale-while-revalidate (best practice on Workers + D1): serve the durable D1
		// MIRROR immediately — it's fast, persists across sessions, and survives a flaky
		// runner tunnel, so the board never blanks on a network blip. Refresh the mirror
		// from the runner in the BACKGROUND for the next poll; the console polls every few
		// seconds, so it converges within one tick. (Returning the mirror — not the raw
		// runner list — also keeps cleared/deleted tasks (hidden=1) off the board even
		// though the runner still re-sends them.) This replaces blocking the board on a
		// live runner round-trip, which went blank whenever the tunnel was slow.
		// Same recentlySeen guard as the /runtime/status probe: a heartbeat within
		// 90s means the runner is alive, so a transient /tasks failure must NOT flip
		// it offline — that would knock out getRunnerConn for coding/apply and flash
		// "not connected" while the runner is actually fine.
		const lastSeenMs = runtime.last_seen_at ? Date.parse(`${runtime.last_seen_at.replace(" ", "T")}Z`) : 0;
		const recentlySeen = lastSeenMs > 0 && Date.now() - lastSeenMs < 90_000;
		const revalidate = (async () => {
			try {
				const res = await callRuntime(c.env, runtime, "/tasks");
				if (res.ok) {
					await mirrorRuntimeTasks(c.env, instanceId, session.uid, await runtimeJson(res));
					await updateRuntimeStatus(c.env, instanceId, session.uid, "online");
				} else if (!recentlySeen) {
					await updateRuntimeStatus(c.env, instanceId, session.uid, "offline");
				}
			} catch {
				if (!recentlySeen) {
					await updateRuntimeStatus(c.env, instanceId, session.uid, "offline").catch(() => undefined);
				}
			}
		})();
		try { c.executionCtx.waitUntil(revalidate); } catch { await revalidate; }
		return c.json({ tasks: await mirroredRuntimeTasks(c.env, instanceId, session.uid) }, 200);
	});

	/**
	 * The single work board: one card per job (task retries collapsed), placed in the
	 * agent's configured columns, with the durable human status override applied.
	 * Read straight from the D1 mirror — the /tasks poll keeps it fresh. Shared by the
	 * console board and the MCP `instance_board` tool so they can't drift.
	 */
	router.get("/:instanceId/board", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		return c.json(await buildInstanceBoard(c.env, instanceId, session.uid));
	});

	/** Move a job to a column (human status override); empty status resets to automation. */
	router.post("/:instanceId/board/status", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const jobKey = (typeof body.jobKey === "string" ? body.jobKey : "").slice(0, 400);
		if (!jobKey) return c.json({ error: "jobKey required" }, 400);
		const status = typeof body.status === "string" ? body.status.trim() : "";
		// Validate a move against the agent's actual columns — reject an unknown status
		// instead of silently parking the card in "Other". Empty = reset to automation.
		if (status) {
			const cols = await columnsForInstance(c.env, instanceId, session.uid);
			const valid = new Set<string>();
			for (const col of cols) { valid.add(col.id); for (const s of col.statuses ?? []) valid.add(s); }
			if (!valid.has(status)) return c.json({ error: `unknown board status: ${status}` }, 400);
		}
		// Snapshot the display fields so a moved card survives its runs being cleared.
		const meta = {
			title: typeof body.title === "string" ? body.title : "",
			subtitle: typeof body.subtitle === "string" ? body.subtitle : "",
			url: typeof body.url === "string" ? body.url : "",
		};
		await setBoardItemStatus(c.env, instanceId, session.uid, jobKey, status || null, meta);
		return c.json({ ok: true });
	});

	/**
	 * Read this instance's board configuration — the columns it shows, the preferred
	 * view (kanban | list), whether the columns are a per-instance override or the
	 * agent's own, and the agent's default columns (for a "reset" affordance). Backs the
	 * console column editor + view toggle and the MCP `get_instance_board_config` tool.
	 */
	router.get("/:instanceId/board-config", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		return c.json(await boardConfigForInstance(c.env, instanceId, session.uid));
	});

	/**
	 * Set a per-instance board override: custom columns and/or the default view. This is
	 * the owner-editable, per-instance layer over the agent's declared columns — settable
	 * from the console UI, the MCP tool, and the agent's own `configure_board` tool.
	 * `columns: null` (or an empty array) resets to the agent's columns.
	 */
	router.put("/:instanceId/board-config", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as { columns?: unknown; view?: unknown };
		const patch: { columns?: BoardColumn[] | null; view?: "kanban" | "list" } = {};
		if ("columns" in body) patch.columns = body.columns === null ? null : (body.columns as BoardColumn[]);
		if (body.view === "kanban" || body.view === "list") patch.view = body.view;
		return c.json(await setInstanceBoardConfig(c.env, instanceId, session.uid, patch));
	});

	/** Create a task on my registered runtime. */
	router.post("/:instanceId/tasks", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		// Route to the machine that's actually live (not the stale default row), so creating a
		// board task on a multi-machine account reaches the connected runner.
		const runtime = await requireLiveRuntime(c.env, instanceId, session.uid);
		const body = normalizeRunnerTaskBody(await c.req.json());
		const res = await callRuntime(c.env, runtime, "/tasks", {
			method: "POST",
			body: JSON.stringify(body),
		});
		const payload = await runtimeJson(res);
		if (res.ok) {
			await mirrorRuntimeTasks(c.env, instanceId, session.uid, payload);
			await mirrorTaskLifecycleEvents(c.env, instanceId, session.uid, payload, "created");
		}
		return c.json(payload, runtimeStatus(res, 202));
	});

	/**
	 * Execute an actionable ticket's declared work and record the outcome on the ticket.
	 * Shared by the explicit `/tasks/:id/run` route and the runner-less fallback in
	 * `/tasks/:id/approve`, so both gates behave identically.
	 *
	 * The action comes from the STORED ticket, never from the request — approving picks whether
	 * the declared work runs, it can't substitute different work.
	 */
	async function runActionableTicket(
		env: Env,
		instanceId: string,
		userId: string,
		taskId: string,
	): Promise<{ body: Record<string, unknown>; status: number }> {
		const stored = await mirroredRuntimeTask(env, instanceId, userId, taskId);
		if (!stored || !isRecord(stored)) return { body: { error: "Task not found" }, status: 404 };

		const ticket = readTicketAction(stored);
		if (!ticket) return { body: { error: "This ticket carries no action to run." }, status: 400 };
		if (!isRunnableStatus(stored.status)) {
			return { body: { error: `Ticket is ${String(stored.status)} — nothing left to approve.`, task: stored }, status: 409 };
		}

		// Claim it first so a double-click (or two console tabs) can't run the work twice.
		const claimed = await env.DB.prepare(
			`UPDATE instance_runtime_tasks SET status = 'running', updated_at = ?1
	     WHERE id = ?2 AND instance_id = ?3 AND user_id = ?4 AND status = ?5`,
		)
			.bind(new Date().toISOString(), taskId, instanceId, userId, String(stored.status))
			.run();
		if ((claimed.meta?.changes ?? 0) === 0) {
			return { body: { error: "Ticket was already picked up.", task: stored }, status: 409 };
		}
		await mirrorRuntimeTask(env, instanceId, userId, { ...stored, status: "running", updatedAt: new Date().toISOString() });

		try {
			const result = await executeTriggerAction(
				env,
				{ action: ticket.action, name: `ticket:${taskId}`, instance_id: instanceId, user_id: userId },
				ticket.config,
				"manual",
				ticket.params,
			);
			const done = { ...stored, status: "completed", result, updatedAt: new Date().toISOString() };
			await mirrorRuntimeTask(env, instanceId, userId, done);
			await logEvent(env, {
				source: "ticket",
				event: "ticket.approved",
				message: `approved ${ticket.action}${ticket.config.pipeline ? ` (${ticket.config.pipeline})` : ""}`,
				userId,
				instanceId,
				context: { taskId, action: ticket.action },
			});
			return { body: { ok: true, task: done, result: result ?? null }, status: 200 };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const failed = { ...stored, status: "failed", error: message, updatedAt: new Date().toISOString() };
			await mirrorRuntimeTask(env, instanceId, userId, failed);
			await logEvent(env, {
				source: "ticket",
				event: "ticket.failed",
				level: "error",
				message,
				userId,
				instanceId,
				context: { taskId, action: ticket.action },
			});
			return { body: { ok: false, error: message, task: failed }, status: 502 };
		}
	}

	/**
	 * Create a board ticket DIRECTLY — no runner required (#150 P3). The normal POST
	 * /tasks delegates to a live local runner and mirrors its response, so runner-less
	 * agents (pipelines, standalone workers, config agents) could never put work on the
	 * board. This inserts a ticket straight into instance_runtime_tasks via mirrorRuntimeTask,
	 * carrying its `reasoning` (the *why*, rendered on the card). Owner-authenticated.
	 */
	router.post("/:instanceId/tasks/direct", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = await c.req
			.json<{
				title?: string;
				reasoning?: string;
				description?: string;
				status?: string;
				type?: string;
				id?: string;
				action?: string;
				config?: Record<string, unknown>;
				params?: Record<string, unknown>;
			}>()
			.catch(() => ({}) as Record<string, never>);
		if (!body.title || typeof body.title !== "string") return c.json({ error: "title required" }, 400);
		// An ACTIONABLE ticket carries the work it stands for, so approving it can carry that
		// work out (see lib/actionable-ticket.ts). Without this a runner-less agent could raise
		// a ticket and nothing could ever act on it.
		const actionError = validateTicketAction(body.action, body.config, body.params);
		if (actionError) return c.json({ error: actionError }, 400);
		const ticketAction = body.action ? buildTicketAction(body.action, body.config, body.params) : null;
		const now = new Date().toISOString();
		const task = {
			id: typeof body.id === "string" && body.id ? body.id.slice(0, 200) : crypto.randomUUID(),
			type: typeof body.type === "string" && body.type ? body.type.slice(0, 120) : "ticket",
			// An actionable ticket defaults to needs_approval (it's waiting on you), while a plain
			// informational ticket stays completed — it's a record, not pending work.
			status: typeof body.status === "string" && body.status ? body.status.slice(0, 80) : ticketAction ? "needs_approval" : "completed",
			title: body.title.slice(0, 200),
			description: typeof body.description === "string" ? body.description.slice(0, 2000) : "",
			reasoning: typeof body.reasoning === "string" ? body.reasoning.slice(0, 8000) : "",
			...(ticketAction ? { action: ticketAction } : {}),
			createdAt: now,
			updatedAt: now,
		};
		await mirrorRuntimeTask(c.env, instanceId, session.uid, task);
		return c.json(task, 201);
	});

	/**
	 * Run an actionable ticket — the runner-less approval gate. Reads the ticket's declared
	 * `action` (fixed when the agent created it; this route never accepts new work), executes it
	 * through the SAME executeTriggerAction path a trigger or connection uses, and moves the
	 * ticket to completed/failed. This is what lets a cloud-only agent ask "shall I?" on the
	 * board: `POST /tasks/:id/approve` needs a live runner, so before this a pipeline agent's
	 * ticket had no way to be carried out.
	 */
	router.post("/:instanceId/tasks/:taskId/run", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const taskId = c.req.param("taskId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const out = await runActionableTicket(c.env, instanceId, session.uid, taskId);
		return c.json(out.body, out.status as ContentfulStatusCode);
	});

	/**
	 * Read one ticket's conversation (#150 P2). The turns are ordinary task events
	 * (`ticket.question` / `ticket.answer`) on the SAME append-only table the ticket's activity
	 * already uses — no new store, and the thread dies with the ticket.
	 */
	router.get("/:instanceId/tasks/:taskId/thread", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const taskId = c.req.param("taskId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const events = await mirroredTaskEvents(c.env, instanceId, session.uid, taskId);
		return c.json({ turns: ticketThreadFromEvents(events) });
	});

	/**
	 * Ask this ticket a question (#150 P2) — the property that turns a board card from a record
	 * you can read into one you can interrogate: "why did you decide that", "what did you skip",
	 * "what happens if I approve this".
	 *
	 * Scoped ON PURPOSE. The answer is built from THIS ticket's record — its reasoning, its
	 * declared action, its activity — and nothing else, so it cannot drift into the instance's
	 * general chat context, and the same question on two tickets gets two answers. The thread has
	 * no tools: it explains work that already happened, it never does work (approving is still the
	 * only thing that runs a ticket's declared action — see lib/actionable-ticket.ts).
	 */
	router.post("/:instanceId/tasks/:taskId/thread", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const taskId = c.req.param("taskId");
		await requireOwnedInstance(c.env, instanceId, session.uid);

		const body = (await c.req.json().catch(() => ({}))) as { message?: unknown };
		const parsed = normalizeTicketQuestion(body.message);
		if ("error" in parsed) return c.json({ error: parsed.error }, 400);

		const task = await mirroredRuntimeTask(c.env, instanceId, session.uid, taskId);
		if (!task || !isRecord(task)) return c.json({ error: "Task not found" }, 404);

		const events = await mirroredTaskEvents(c.env, instanceId, session.uid, taskId);
		const askedAt = new Date().toISOString();
		const questionEvent = {
			id: `ticketq_${crypto.randomUUID()}`,
			taskId,
			type: TICKET_QUESTION_EVENT,
			message: parsed.question,
			createdAt: askedAt,
		};
		// Persist the question BEFORE the model call: if inference fails (no key, provider down),
		// the owner's question must still be on the ticket rather than vanishing with the error.
		await mirrorRuntimeEvent(c.env, instanceId, session.uid, questionEvent);

		const cfg = await readInstanceConfig(c.env, instanceId, session.uid);
		const messages = buildTicketChatMessages({
			task,
			events,
			question: parsed.question,
			specialInstructions: typeof cfg.specialInstructions === "string" ? cfg.specialInstructions : "",
		});

		let answer = "";
		try {
			const res = (await runUserWorkersAi(c.env, session.uid, "claude-sonnet-4-6", { messages, maxTokens: 700 }, {
				kind: "chat",
				instanceId,
			})) as { response?: string };
			answer = (res.response || "").slice(0, MAX_TICKET_ANSWER_CHARS);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const status = isRecord(err) && typeof err.status === "number" ? err.status : 502;
			return c.json({ error: message, question: questionEvent }, status as ContentfulStatusCode);
		}
		if (!answer.trim()) return c.json({ error: "The agent returned an empty answer.", question: questionEvent }, 502);

		const answerEvent = {
			id: `ticketa_${crypto.randomUUID()}`,
			taskId,
			type: TICKET_ANSWER_EVENT,
			message: answer,
			createdAt: new Date().toISOString(),
		};
		await mirrorRuntimeEvent(c.env, instanceId, session.uid, answerEvent);
		return c.json({ question: questionEvent, answer: answerEvent });
	});

	/**
	 * Start the remote LLM brain on a job application. Kicks off the JobApplyWorkflow
	 * which drives the connected runner page-by-page (snapshot → Claude → act),
	 * handing off to a human only for a CAPTCHA. Returns the workflow instance id.
	 */
	/**
	 * Read one task. If a live runner is registered we ask it (and re-mirror the fresh
	 * copy); otherwise — and on ANY runtime error — we serve the mirrored ticket from
	 * instance_runtime_tasks. Runner-less agents (pipelines, config agents) have no
	 * runtime at all, so requiring one here 404'd their tickets and the run-detail page
	 * came up empty; the mirrored row carries the full ticket (title/description/reasoning).
	 */
	router.get("/:instanceId/tasks/:taskId", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const taskId = c.req.param("taskId");
		try {
			// The LIVE node, not the default row (#218): on a multi-machine account the default can
			// name a machine that has gone away, so the read hits a dead relay and the user is shown
			// stale task detail. No live runner throws, and the catch below serves the mirror.
			const runtime = await requireLiveRuntime(c.env, instanceId, session.uid);
			const res = await callRuntime(c.env, runtime, `/tasks/${encodeURIComponent(taskId)}`);
			const payload = await runtimeJson(res);
			if (res.ok) {
				await mirrorRuntimeTasks(c.env, instanceId, session.uid, payload);
				return c.json(payload, 200);
			}
			const live = await mirroredRuntimeTask(c.env, instanceId, session.uid, taskId);
			if (live) return c.json({ ...(isRecord(live) ? live : {}), runtimeUnavailable: true });
			return c.json(payload, runtimeStatus(res, 200));
		} catch {
			/* no runtime registered, or the runner is unreachable → fall back to the mirror */
		}
		const mirrored = await mirroredRuntimeTask(c.env, instanceId, session.uid, taskId);
		if (mirrored) return c.json(isRecord(mirrored) ? mirrored : {});
		return c.json({ error: "Task not found" }, 404);
	});

	/** Approve a task waiting on local human approval. */
	router.post("/:instanceId/tasks/:taskId/approve", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		// A runner-less agent's ticket carries its own action — approve it here rather than
		// demanding a live runner it will never have. Checked FIRST: an actionable ticket is
		// self-contained, so there is nothing for a runner to approve even if one is connected.
		const taskId = c.req.param("taskId");
		const stored = await mirroredRuntimeTask(c.env, instanceId, session.uid, taskId);
		if (readTicketAction(stored)) {
			const out = await runActionableTicket(c.env, instanceId, session.uid, taskId);
			return c.json(out.body, out.status as ContentfulStatusCode);
		}
		// Approving a paused task must reach the LIVE runner (the machine the task is running on),
		// not the stale default row — otherwise approve silently no-ops on a multi-machine account.
		const runtime = await requireLiveRuntime(c.env, instanceId, session.uid);
		const res = await callRuntime(
			c.env,
			runtime,
			`/tasks/${encodeURIComponent(c.req.param("taskId"))}/approve`,
			{ method: "POST" },
		);
		const payload = await runtimeJson(res);
		if (res.ok) {
			await mirrorRuntimeTasks(c.env, instanceId, session.uid, payload);
			await mirrorTaskLifecycleEvents(c.env, instanceId, session.uid, payload, "approved");
		}
		return c.json(payload, runtimeStatus(res, 200));
	});

	/** Cancel a runtime task. */
	/** Send free-text guidance to a paused/stuck agent's brain (read on resume). */
	router.post("/:instanceId/tasks/:taskId/hint", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const taskId = c.req.param("taskId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const hint = String(body.hint ?? "").trim().slice(0, 2000);
		if (!hint) return c.json({ error: "hint required" }, 400);
		await c.env.DB.prepare("UPDATE instance_runtime_tasks SET user_hint = ?1 WHERE id = ?2 AND instance_id = ?3 AND user_id = ?4")
			.bind(hint, taskId, instanceId, session.uid)
			.run();
		return c.json({ ok: true });
	});

	/** Clear all finished (failed/done/cancelled) tasks from the board. */
	router.post("/:instanceId/tasks/clear-finished", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const cleared = await clearFinishedRuntimeTasks(c.env, instanceId, session.uid);
		await clearFinishedBoardItems(c.env, instanceId, session.uid);
		return c.json({ ok: true, cleared });
	});

	/** Delete a ticket: stop the runner task (best-effort) + drop it from the board. */
	router.delete("/:instanceId/tasks/:taskId", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const taskId = c.req.param("taskId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		// Best-effort stop on the LIVE node (#218). getRuntime returned the default row, which is
		// not cleared on disconnect — so the cancel could be posted at a machine that is gone while
		// the task kept running on the one that is actually connected, and the board hid it anyway.
		const runtime = await getLiveRuntime(c.env, instanceId, session.uid);
		if (runtime?.endpoint_url) {
			await callRuntime(c.env, runtime, `/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" }).catch(() => undefined);
		}
		await deleteMirroredRuntimeTask(c.env, instanceId, session.uid, taskId);
		return c.json({ ok: true });
	});

	router.post("/:instanceId/tasks/:taskId/cancel", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		// Mutating: reach the live node or report offline, rather than dispatching at a stale row
		// and reporting success for a cancel that never happened (#218).
		const runtime = await requireLiveRuntime(c.env, instanceId, session.uid);
		const res = await callRuntime(
			c.env,
			runtime,
			`/tasks/${encodeURIComponent(c.req.param("taskId"))}/cancel`,
			{ method: "POST" },
		);
		const payload = await runtimeJson(res);
		if (res.ok) {
			await mirrorRuntimeTasks(c.env, instanceId, session.uid, payload);
			await mirrorTaskLifecycleEvents(c.env, instanceId, session.uid, payload, "cancelled");
		}
		return c.json(payload, runtimeStatus(res, 200));
	});

	/** Read recent task events from my registered runtime. */
	router.get("/:instanceId/task-events", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const rawLimit = Number(c.req.query("limit") || "100");
		const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.trunc(rawLimit))) : 100;
		// Live node or the mirror — never the stale default row (#218).
		const runtime = await getLiveRuntime(c.env, instanceId, session.uid);
		if (!runtime) {
			const events = await mirroredRuntimeEvents(c.env, instanceId, session.uid, limit);
			const tasks = events.length ? [] : await mirroredRuntimeTasks(c.env, instanceId, session.uid, limit);
			return c.json({
				events: events.length ? events : syntheticEventsFromTasks(tasks.length ? tasks : [runtimeSetupTask(instanceId)]),
				runtimeUnavailable: true,
				error: "Runtime not registered",
			});
		}
		// Stale-while-revalidate (same as /tasks): serve the D1 mirror immediately so the
		// activity feed never blanks/lags on a flaky tunnel; refresh from the runner in the
		// background. Falls back to events synthesised from tasks when there's no history.
		const lastSeenMs2 = runtime.last_seen_at ? Date.parse(`${runtime.last_seen_at.replace(" ", "T")}Z`) : 0;
		const recentlySeen2 = lastSeenMs2 > 0 && Date.now() - lastSeenMs2 < 90_000;
		const revalidate = (async () => {
			try {
				const res = await callRuntime(c.env, runtime, `/events?limit=${encodeURIComponent(String(limit))}`);
				if (res.ok) await mirrorRuntimeEvents(c.env, instanceId, session.uid, await runtimeJson(res));
				else if (!recentlySeen2) await updateRuntimeStatus(c.env, instanceId, session.uid, "offline");
			} catch {
				if (!recentlySeen2) {
					await updateRuntimeStatus(c.env, instanceId, session.uid, "offline").catch(() => undefined);
				}
			}
		})();
		try { c.executionCtx.waitUntil(revalidate); } catch { await revalidate; }
		const events = await mirroredRuntimeEvents(c.env, instanceId, session.uid, limit);
		const tasks = events.length ? [] : await mirroredRuntimeTasks(c.env, instanceId, session.uid, limit);
		return c.json({ events: events.length ? events : syntheticEventsFromTasks(tasks) }, 200);
	});
}
