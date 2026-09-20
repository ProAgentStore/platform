/**
 * The WRITE half of the ask-gate: a connector call the owner set to "Ask each time" goes to the
 * board instead of out (#722 Step 2, #90's acceptance criterion 2).
 *
 * The other halves are neighbours, and the split is a dependency fact rather than taste. What the
 * card SAYS is pure (`tool-approval.ts`). What a ticket may CARRY is pure
 * (`actionable-ticket.ts`). Approving one has to resolve the instance's live tool policy, which
 * reaches back into the tool catalog — so it lives in `tool-approval-run.ts`, on the ROUTE's side
 * of the graph, and this module stays importable from `tool-registry.ts` without closing a cycle
 * through it (`import-graph.test.ts` is the thing that noticed).
 */
import type { Env } from "../types.js";
import { getConnector } from "./connectors/registry.js";
import type { RegistryToolCtx, ToolDef } from "./connectors/types.js";
import { logEvent } from "./events.js";
import { approvalFingerprint, buildApprovalCard, queuedCallMessage, TOOL_APPROVAL_TASK_TYPE } from "./tool-approval.js";

/** How many pending approval cards to scan for a duplicate. An owner with more than this many
 *  un-actioned approvals has a bigger problem than a duplicate card, and an unbounded scan on a
 *  hot path is its own defect. */
const DUPLICATE_SCAN_LIMIT = 50;

/**
 * Put an ask-mode write on the board instead of running it, and answer the gate with what the
 * MODEL should be told (#722).
 *
 * `success: true` on the queued path is deliberate. Nothing went wrong — the platform did exactly
 * what the owner configured — and a `success: false` would read to the model as an error to route
 * around: retry, reach for another tool, apologise for a failure that did not happen.
 *
 * CANNOT-QUEUE IS A REFUSAL, NEVER A DISPATCH. Both failure paths below return `success: false`
 * and run nothing. Without an owner there is no board to put the card on, and the only two things
 * available are "refuse" and "send it anyway" — a gate that falls through to sending when its own
 * bookkeeping fails is not a gate.
 *
 * The `instanceId` half of that first guard is defence-in-depth rather than a live path: consent
 * is keyed by instance, so a call carrying none has already been refused by the consent check that
 * precedes this one and cannot arrive here. It is checked anyway because the thing that makes it
 * unreachable lives in a different function, and "unreachable via today's only caller" is not a
 * property to bet an irreversible send on.
 *
 * The same call queued twice returns the FIRST ticket and writes no second card (see
 * `approvalFingerprint`): a model told "queued for approval" over three turns would otherwise
 * leave an owner three identical cards, unable to tell a duplicate from a second genuine send.
 */
export async function queueToolCallForApproval(
	env: Env,
	tool: ToolDef,
	ctx: RegistryToolCtx,
	instanceId: string,
	args: Record<string, unknown>,
): Promise<{ content: string; success: boolean }> {
	const connectorLabel = (tool.connector ? getConnector(tool.connector)?.label : null) ?? tool.connector ?? "this connector";
	if (!instanceId || !ctx.userId) {
		return {
			content:
				`${tool.name} needs the owner's approval before it runs — write access for ${connectorLabel} on this agent is set to "Ask each time" — ` +
				"but this call names no subscribed instance whose board the approval could go on, so it was refused rather than sent.",
			success: false,
		};
	}
	try {
		const queued = await writeApprovalTicket(env, {
			instanceId,
			userId: ctx.userId,
			tool,
			args,
			traceId: ctx.traceId ?? null,
		});
		return {
			content: queuedCallMessage({ toolName: tool.name, connectorLabel, ticketId: queued.ticketId, duplicate: queued.duplicate }),
			success: true,
		};
	} catch (err) {
		return {
			content:
				`${tool.name} needs the owner's approval before it runs, and the approval could not be written to the board ` +
				`(${err instanceof Error ? err.message : String(err)}) — so it was refused rather than sent. Try again.`,
			success: false,
		};
	}
}

interface QueuedApproval {
	ticketId: string;
	/** True when this exact call was already waiting — no second card was written. */
	duplicate: boolean;
}

/** Write (or find) the `call_tool` ticket. Throws on a store failure; the caller turns that into
 *  a refusal rather than a dispatch. */
async function writeApprovalTicket(
	env: Env,
	opts: { instanceId: string; userId: string; tool: ToolDef; args: Record<string, unknown>; traceId: string | null },
): Promise<QueuedApproval> {
	const { tool } = opts;
	const connector = tool.connector ? getConnector(tool.connector) : null;
	const key = approvalFingerprint(tool.name, opts.args);
	const existing = await findPendingApproval(env, opts.instanceId, opts.userId, key);
	if (existing) return { ticketId: existing, duplicate: true };

	const card = buildApprovalCard({
		toolName: tool.name,
		connectorLabel: connector?.label ?? tool.connector ?? "this connector",
		schema: tool.jsonSchema,
		args: opts.args,
	});
	const now = new Date().toISOString();
	const task = {
		id: crypto.randomUUID(),
		type: TOOL_APPROVAL_TASK_TYPE,
		status: "needs_approval",
		title: card.title,
		description: card.description,
		reasoning: card.reasoning,
		// The action is fixed HERE, by the platform, from the call it just refused — never from
		// anything a model supplied. `validateTicketAction` refuses `call_tool` from every other
		// door for exactly this reason (see GATE_ONLY_TICKET_ACTIONS).
		action: { action: "call_tool", config: {}, params: { tool: tool.name, args: opts.args } },
		approvalKey: key,
		connector: tool.connector ?? "",
		createdAt: now,
		updatedAt: now,
	};
	const { mirrorRuntimeTask } = await import("../routes/instances-runtime.js");
	await mirrorRuntimeTask(env, opts.instanceId, opts.userId, task);
	// #90's other half: "all connector writes audited". A write that was WITHHELD is as much part
	// of that record as one that ran — more, since it is the evidence the gate did anything.
	await logEvent(env, {
		source: "tool",
		event: "tool_call.queued_for_approval",
		message: `${tool.name} queued for approval (${tool.connector} write access is "ask")`,
		userId: opts.userId,
		instanceId: opts.instanceId,
		traceId: opts.traceId,
		level: "info",
		context: { tool: tool.name, connector: tool.connector ?? null, taskId: task.id },
	}).catch(() => undefined);
	return { ticketId: task.id, duplicate: false };
}

/** The id of a pending approval ticket for this exact call, or null. */
async function findPendingApproval(env: Env, instanceId: string, userId: string, key: string): Promise<string | null> {
	try {
		const { results } = await env.DB.prepare(
			`SELECT id, payload FROM instance_runtime_tasks
			 WHERE instance_id = ?1 AND user_id = ?2 AND type = ?3 AND status = 'needs_approval'
			 ORDER BY updated_at DESC LIMIT ?4`,
		)
			.bind(instanceId, userId, TOOL_APPROVAL_TASK_TYPE, DUPLICATE_SCAN_LIMIT)
			.all<{ id: string; payload: string }>();
		for (const row of results ?? []) {
			try {
				const parsed = JSON.parse(row.payload) as { approvalKey?: unknown };
				if (parsed?.approvalKey === key) return row.id;
			} catch {
				/* a payload we cannot parse is not a match — fall through and write a fresh card */
			}
		}
	} catch {
		// A failed dedup read must not block the gate: the worst case is a second card, and an
		// extra card is an inconvenience where a swallowed refusal would be a silent send.
	}
	return null;
}
