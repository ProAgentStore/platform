import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError, requireUser } from "../lib/auth.js";
import { logEvent } from "../lib/events.js";
import { touchInstanceActivity } from "../lib/instance-config.js";
import { postSystemMessage } from "../lib/instance-system-message.js";
import { isCredentialsError, runLoopDecide } from "../lib/loop-orchestrator.js";
import { attachGlossesToMessages } from "./instances-translation.js";
import {
	cloudflareAiSetupTask,
	cloudflareAiSetupTaskId,
	deleteMirroredRuntimeTask,
	isCloudflareAiCredentialsError,
	isRecord,
	mirrorRuntimeTask,
	mirrorSyntheticTaskEvent,
	type InstanceRow,
} from "./instances-runtime.js";
import type { Env } from "../types.js";

/**
 * The conversation with an instance (#305): the chat turn itself, the loop orchestrator that
 * drives it autonomously, the system-message channel, and message history.
 *
 * WHY THIS IS ONE MODULE. All four are about the AgentDO's message log — three write to it and
 * one reads it back — and they are the only routes on this surface that do. They also share the
 * ownership shape that the rest of the file does not: a bare `SELECT id FROM agent_instances
 * WHERE id = ?1 AND user_id = ?2` rather than `requireOwnedInstance`, because none of them needs
 * the row, only the permission. `instances.contract.test.ts` derives that both spellings refuse a
 * stranger identically, which is the only thing that makes the difference safe to keep.
 */
export function registerChatRoutes(router: Hono<{ Bindings: Env }>): void {
	/** Chat with my instance of an agent. */
	router.post("/:instanceId/chat", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");

		// Ownership BEFORE validation (#350). The other order is an existence oracle: a stranger
		// sending `{}` got 400 "message required" for an instance that exists and 400 for one that
		// does not — but a WELL-FORMED body got 404 only for the second, so the pair of answers
		// distinguished "not yours" from "no such id". Nothing else on this surface leaks that, and
		// checking the tenant first costs the same single SELECT it always did.
		const instance = await c.env.DB.prepare(
			"SELECT id, agent_id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
		)
			.bind(instanceId, session.uid)
			.first<InstanceRow>();
		if (!instance) throw new HttpError(404, "Instance not found");

		const { message, audioKey, dictation } = await c.req.json<{ message: string; audioKey?: string; dictation?: string }>();
		if (!message) throw new HttpError(400, "message required");

		const doId = c.env.AGENT.idFromName(instanceId);
		const stub = c.env.AGENT.get(doId);
		// Pass agentId/agentName for auto-init if DO has no state
		const agentMeta = await c.env.DB.prepare(
			"SELECT name FROM agents WHERE id = ?1",
		).bind(instance.agent_id).first<{ name: string }>();

		// The turn's identity, minted BEFORE the DO is asked (#514). It used to be minted after the
		// reply came back, which had two consequences that only look small: the DO's own warn-level
		// events about this very turn — `chat.truncated` and `chat.invented_result`, the two rows
		// that record the platform catching its own agent — were written with `trace_id = NULL`
		// (agent-think.ts reads `delegation.traceId`, which only the Loop ever supplied), so they
		// could never be joined to the `chat.in`/`chat.out` pair beside them; and `chat.in` was
		// stamped `Date.now()` at the END of the turn, measured 7,792 ms after the user actually
		// spoke on instance 5fab318d. A trace whose "when the user spoke" is off by a whole turn
		// cannot be matched to a transcript by timestamp at all, and with concurrent turns on one
		// instance (#429) that window can contain another exchange entirely.
		const turnId = crypto.randomUUID();
		const startedAt = Date.now();

		const doRes = await stub.fetch(
			new Request("https://agent/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					message, channel: "chat", userId: session.uid,
					agentId: instanceId, agentName: agentMeta?.name || "Agent",
					audioKey, dictation, traceId: turnId,
				}),
			}),
		);

		// Track usage
		await c.env.DB.prepare(
			`INSERT INTO usage (id, agent_id, user_id, event, metadata, created_at)
	     VALUES (?1, ?2, ?3, 'instance_chat', ?4, datetime('now'))`,
		)
			.bind(
				crypto.randomUUID(),
				instance.agent_id,
				session.uid,
				JSON.stringify({ instanceId }),
			)
			.run();

		// The AgentDO's own catch returns JSON, but a hard crash (CPU limit / isolate
		// reset mid-response) makes the platform return a NON-JSON body. Parsing that
		// blindly threw a SyntaxError that surfaced as an opaque, untraced 500 — the
		// exact shape of the invisible "chat → 500" reports. Read text, then parse.
		const raw = await doRes.text();
		let data: unknown;
		try {
			data = raw ? JSON.parse(raw) : {};
		} catch {
			data = { error: raw.slice(0, 500) || `Agent did not return a valid response (${doRes.status})` };
		}
		if (doRes.ok) {
			// Trace the turn (in → tools → out) grouped by one turn id so agent_trace
			// shows what the agent was asked, which tools it ran, and what it replied.
			// Still written only on success, and only here: a failed turn's events are the error
			// log's job, and changing that alongside the id would confuse two fixes (#514).
			const reply = isRecord(data) && isRecord(data.message) ? String(data.message.content ?? "") : "";
			const tools = isRecord(data) && isRecord(data.toolMessage) ? String(data.toolMessage.content ?? "") : "";
			// `chat.in` carries the time the request ARRIVED, not the time the reply finished, so it
			// lands within a few ms of the user message's own createdAt and the two are matchable.
			// `startedAt < now` always, so listEvents' ts ordering still reads in → tools → out.
			const now = Date.now();
			await logEvent(c.env, { source: "chat", event: "chat.in", message: message.slice(0, 200), userId: session.uid, instanceId, traceId: turnId, ts: startedAt });
			if (tools) await logEvent(c.env, { source: "chat", event: "tool.call", message: tools.replace(/\s+/g, " ").slice(0, 200), userId: session.uid, instanceId, traceId: turnId, ts: now });
			await logEvent(c.env, { source: "chat", event: "chat.out", message: reply.replace(/\s+/g, " ").slice(0, 200), userId: session.uid, instanceId, traceId: turnId, ts: now + 1 });
			// Bump last_activity_at — chat is the primary signal for "used recently".
			// Fire-and-forget: a write failure must not surface as a request error.
			void touchInstanceActivity(c.env, instanceId, session.uid);
			await deleteMirroredRuntimeTask(
				c.env,
				instanceId,
				session.uid,
				cloudflareAiSetupTaskId(instanceId),
			);
		} else if (
			isRecord(data) &&
			isCloudflareAiCredentialsError(data.error)
		) {
			const task = cloudflareAiSetupTask(instanceId, String(data.error));
			await mirrorRuntimeTask(c.env, instanceId, session.uid, task);
			await mirrorSyntheticTaskEvent(
				c.env,
				instanceId,
				session.uid,
				task,
				"setup.blocked",
				task.updatedAt,
				{ provider: "cloudflare" },
			);
		}
		return c.json(data as Record<string, unknown>, (doRes.ok ? 200 : doRes.status) as ContentfulStatusCode);
	});

	/** Loop orchestrator — BYOK Claude decides next action for an autonomous loop. */
	router.post("/:instanceId/loop-decide", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const instance = await c.env.DB.prepare(
			"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
		).bind(instanceId, session.uid).first();
		if (!instance) throw new HttpError(404, "Instance not found");

		const { objective, messages, iteration, maxIterations } = await c.req.json<{
			objective: string;
			messages: { role: string; content: string }[];
			iteration: number;
			maxIterations: number;
		}>();
		if (!objective || typeof objective !== "string") throw new HttpError(400, "objective required");
		if (objective.length > 2000) throw new HttpError(400, "objective too long");
		if (!Array.isArray(messages)) throw new HttpError(400, "messages must be an array");
		if (messages.length > 20) throw new HttpError(400, "too many messages");

		// #158: the prompt + model call now live in lib/loop-orchestrator.ts, shared with the durable
		// AgentLoopWorkflow. They were about to diverge (this route inlined the prompt), and two
		// orchestrators disagreeing about when a run is "done" is a bug nobody finds for a month.
		try {
			const decision = await runLoopDecide(c.env, session.uid, instanceId, { objective, messages, iteration, maxIterations });
			return c.json(decision);
		} catch (e) {
			// A missing BYOK key is the user's to fix and fails identically on every retry, so it
			// stays a clear 402 rather than a silent "escalate" decision.
			if (isCredentialsError(e)) throw new HttpError(402, "No API key configured. Add one in Profile → API Keys.");
			throw e;
		}
	});

	/** Persist a system/status message to the instance chat history. */
	router.post("/:instanceId/system-message", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const instance = await c.env.DB.prepare(
			"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
		).bind(instanceId, session.uid).first();
		if (!instance) throw new HttpError(404, "Instance not found");
		const { content } = await c.req.json<{ content: string }>();
		if (!content) throw new HttpError(400, "content required");
		await postSystemMessage(c.env, instanceId, content);
		return c.json({ ok: true });
	});

	/** Get messages for my instance. */
	router.get("/:instanceId/messages", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");

		const instance = await c.env.DB.prepare(
			"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
		)
			.bind(instanceId, session.uid)
			.first();
		if (!instance) throw new HttpError(404, "Instance not found");

		const rawLimit = Number(c.req.query("limit") || "50");
		const limit = Math.max(1, Math.min(2000, Number.isFinite(rawLimit) ? rawLimit : 50));
		const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
		// #428: this used to rebuild the DO query string from scratch with only `limit`, so
		// `before` never reached the object and "Load older messages" re-served the newest page.
		// Build it from parts rather than adding a second literal to keep in step.
		const params = new URLSearchParams({ limit: String(limit) });
		const before = c.req.query("before");
		if (before) params.set("before", before);
		const doRes = await stub.fetch(new Request(`https://agent/messages?${params}`));
		const payload = (await doRes.json()) as { messages?: Array<Record<string, unknown>>; error?: string };
		// A cursor the DO refuses is the caller's mistake and must stay visible as one — passing
		// it through as an empty 200 is how the original defect hid for as long as it did.
		if (!doRes.ok) return c.json(payload, doRes.status as ContentfulStatusCode);
		// Cached glosses ride along so translated history renders in the same paint —
		// see instances-translation.ts.
		await attachGlossesToMessages(c.env, instanceId, session.uid, payload.messages || []);
		return c.json(payload);
	});
}
