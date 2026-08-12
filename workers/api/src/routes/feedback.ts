/**
 * `/v1/feedback` — the owner's in-session complaints about their own agents (#514).
 *
 * ONE route serves both read surfaces, following `errors.ts` exactly: the per-instance Feedback
 * tab passes `?instance_id=`, the platform-wide Feedback page does not. Everything is scoped to
 * `session.uid`; there is no `scope=all`, not even for an admin — an operator reading what a user
 * privately said about an agent is a different feature with a privacy answer attached.
 *
 * The capture path deliberately touches NO model. #504 (a Pilot emitting 11 empty tool_use blocks
 * out of 19) and #503 (an agent whose tool results were silently truncated) are the existence
 * proof that the turn on which an agent is malfunctioning is the turn least able to correctly call
 * a tool about its own malfunction. The `record_feedback` tool exists as well, because the owner
 * will say "that's wrong, write that down" mid-conversation — but this is the path that cannot
 * fail for the reason being reported.
 */
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import {
	buildFeedbackRow,
	deleteFeedback,
	FEEDBACK_STATUSES,
	insertFeedback,
	listFeedback,
	updateFeedback,
	type FeedbackStatus,
} from "../lib/feedback.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

export const feedbackRoutes = new Hono<{ Bindings: Env }>();

const asStatus = (v: unknown): FeedbackStatus | undefined =>
	typeof v === "string" && (FEEDBACK_STATUSES as readonly string[]).includes(v) ? (v as FeedbackStatus) : undefined;

/** Record one complaint. Owner-scoped through the instance it is about. */
feedbackRoutes.post("/", async (c) => {
	const session = await requireUser(c);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const instanceId = typeof body.instanceId === "string" ? body.instanceId : "";
	if (!instanceId) throw new HttpError(400, "instanceId required");
	// 404s a stranger before anything is written, and before the payload is even looked at — the
	// same ownership-first order instances-chat.ts adopted in #350.
	await requireOwnedInstance(c.env, instanceId, session.uid);

	const built = buildFeedbackRow({
		userId: session.uid,
		instanceId,
		body: typeof body.body === "string" ? body.body : "",
		author: typeof body.author === "string" ? body.author : "user",
		surface: typeof body.surface === "string" ? body.surface : undefined,
		sentiment: typeof body.sentiment === "string" ? body.sentiment : null,
		traceId: typeof body.traceId === "string" ? body.traceId : null,
		messageId: typeof body.messageId === "string" ? body.messageId : null,
		sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
		timelineSeq: typeof body.timelineSeq === "number" ? body.timelineSeq : null,
		targetRole: typeof body.targetRole === "string" ? body.targetRole : null,
		targetText: typeof body.targetText === "string" ? body.targetText : null,
		targetAt: typeof body.targetAt === "string" ? body.targetAt : null,
		promptText: typeof body.promptText === "string" ? body.promptText : null,
		context: body.context && typeof body.context === "object" ? (body.context as Record<string, unknown>) : null,
	});
	if (!built.ok) throw new HttpError(400, built.error);
	await insertFeedback(c.env, built.row);
	return c.json({ ok: true, feedback: built.row }, 201);
});

/** My feedback, newest first. `?instance_id=` for one agent, `?status=` for triage. */
feedbackRoutes.get("/", async (c) => {
	const session = await requireUser(c);
	const rows = await listFeedback(c.env, {
		userId: session.uid,
		instanceId: c.req.query("instance_id") || undefined,
		status: asStatus(c.req.query("status")),
		limit: Number(c.req.query("limit")) || 100,
	});
	return c.json({ count: rows.length, feedback: rows });
});

/** Triage: move the status, record the issue it became. The body is never editable — see lib. */
feedbackRoutes.patch("/:id", async (c) => {
	const session = await requireUser(c);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const status = asStatus(body.status);
	const hasIssue = "issue_url" in body || "issueUrl" in body;
	if (!status && !hasIssue) throw new HttpError(400, "status or issue_url required");
	const raw = (body.issue_url ?? body.issueUrl) as unknown;
	const ok = await updateFeedback(c.env, {
		id: c.req.param("id"),
		userId: session.uid,
		status,
		...(hasIssue ? { issueUrl: typeof raw === "string" && raw.trim() ? raw.trim() : null } : {}),
	});
	if (!ok) throw new HttpError(404, "Feedback not found");
	return c.json({ ok: true });
});

/** Hard delete. It outlives the conversation, so it has to be reachable by "delete my data". */
feedbackRoutes.delete("/:id", async (c) => {
	const session = await requireUser(c);
	const ok = await deleteFeedback(c.env, { id: c.req.param("id"), userId: session.uid });
	if (!ok) throw new HttpError(404, "Feedback not found");
	return c.json({ ok: true });
});
