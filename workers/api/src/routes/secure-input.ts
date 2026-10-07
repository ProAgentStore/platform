// Secure input request endpoints (#906)
//
// These endpoints are called by:
// 1. Agents (via MCP tools) to create/check/inject secure input requests
// 2. The console UI (owner-facing) to display pending requests and submit secret values
//
// Critical invariant: plaintext secrets are NEVER returned by any route.
// All responses are metadata-only.

import { Hono, type Context } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { consumeSecureInput, countSecureInputRequests, createSecureInputRequest, getSecureInputStatus, listSecureInputRequests, pendingOwnerInputs, storeSecretValue } from "../lib/secure-input.js";
import { secureInputLink, secureInputNotificationLink } from "../lib/console-links.js";
import { instanceListName } from "../lib/instance-config.js";
import { notifyUser } from "./push.js";
import type { Env } from "../types.js";

export const secureInputRoutes = new Hono<{ Bindings: Env }>();

/** Confirm the caller owns the instance. */
async function requireOwned(c: Context<{ Bindings: Env }>): Promise<{ uid: string; instanceId: string }> {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId") ?? c.req.param("id") ?? "";
	const owned = await c.env.DB.prepare("SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, session.uid).first();
	if (!owned) throw new HttpError(404, "Instance not found");
	return { uid: session.uid, instanceId };
}

/**
 * POST /:instanceId/secure-inputs
 * Create a new secure input request (agent calls this via MCP tool).
 * Returns the request ID (opaque reference for later use).
 */
secureInputRoutes.post("/:instanceId/secure-inputs", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

	const label = typeof body.label === "string" ? body.label.trim() : "";
	const purpose = typeof body.purpose === "string" ? body.purpose.trim() : undefined;
	const destinationScope = body.destinationScope as string | undefined;

	if (!label || !["tmux", "env", "stdin", "file"].includes(destinationScope ?? "")) {
		throw new HttpError(400, "label and destinationScope (tmux|env|stdin|file) are required");
	}

	const requestId = await createSecureInputRequest(c.env, {
		instanceId,
		userId: uid,
		label,
		purpose,
		destinationScope: destinationScope as "tmux" | "env" | "stdin" | "file",
		oneShot: body.oneShot !== false,
	});

	const consoleUrl = secureInputLink(instanceId, requestId);
	// The owner is TOLD (#934): the URL above reaches only the agent, so a request used to sit unseen
	// for up to a day while the run that asked for it waited. An alert — a blocked run is waiting on
	// a human — deep-linked to the request. The label only; there is no value yet, and never would be.
	// Best-effort: failing to notify must not fail the request the agent is about to wait on.
	await notifyOwner(c.env, uid, instanceId, requestId, label).catch(() => undefined);
	return c.json({ id: requestId, consoleUrl }, 201);
});

async function notifyOwner(env: Env, uid: string, instanceId: string, requestId: string, label: string): Promise<void> {
	const row = await env.DB.prepare("SELECT i.config, a.name FROM agent_instances i JOIN agents a ON a.id = i.agent_id WHERE i.id = ?1 AND i.user_id = ?2")
		.bind(instanceId, uid)
		.first<{ config: string | null; name: string | null }>();
	const agent = instanceListName(row?.config, row?.name) ?? "Your agent";
	await notifyUser(env, uid, "secure-input", `🔐 ${agent} needs a value`, `“${label}” — enter it in the console. The agent never sees it.`, secureInputNotificationLink(instanceId, requestId), {
		kind: "alert",
		instanceId,
		key: `secure-input:${requestId}`,
	});
}

/**
 * GET /my/secure-inputs
 * Per instance, the owner-facing requests still waiting for a value (#934) — the instance cards'
 * "waiting for you" count, in one call for the whole account. Registered BEFORE the
 * `/:instanceId/…` routes so `my` is never read as an instance id.
 */
secureInputRoutes.get("/my/secure-inputs", async (c) => {
	const session = await requireUser(c);
	return c.json({ instances: await pendingOwnerInputs(c.env, session.uid) });
});

/**
 * GET /:instanceId/secure-inputs
 * List pending secure input requests (metadata only) — a page with its place in the whole (#954).
 */
secureInputRoutes.get("/:instanceId/secure-inputs", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const limit = Math.max(1, Math.min(50, Number(c.req.query("limit")) || 20));
	const offset = Math.max(0, Math.trunc(Number(c.req.query("offset")) || 0));
	// `?status=all` (#929): the history as well as what is still open.
	const all = c.req.query("status") === "all";
	const [requests, total] = await Promise.all([listSecureInputRequests(c.env, instanceId, uid, limit, offset, all), countSecureInputRequests(c.env, instanceId, uid, all)]);
	return c.json({ requests, total, offset, nextOffset: offset + requests.length < total ? offset + requests.length : null });
});

/**
 * GET /:instanceId/secure-inputs/:requestId
 * Get the status of a specific secure input request (metadata only).
 */
secureInputRoutes.get("/:instanceId/secure-inputs/:requestId", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const requestId = c.req.param("requestId") ?? "";
	const status = await getSecureInputStatus(c.env, requestId, instanceId, uid);
	if (!status) throw new HttpError(404, "Request not found");
	return c.json(status);
});

/**
 * POST /:instanceId/secure-inputs/:requestId/submit
 * Submit the secret value for a pending request (console UI calls this).
 * Encrypts the value and marks request as 'ready'.
 */
secureInputRoutes.post("/:instanceId/secure-inputs/:requestId/submit", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const requestId = c.req.param("requestId") ?? "";
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

	const value = typeof body.value === "string" ? body.value : "";
	if (!value) throw new HttpError(400, "value is required");

	const success = await storeSecretValue(c.env, requestId, instanceId, uid, value);
	if (!success) throw new HttpError(404, "Request not found or already consumed");

	const status = await getSecureInputStatus(c.env, requestId, instanceId, uid);
	return c.json(status);
});

/**
 * POST /:instanceId/secure-inputs/:requestId/consume
 * Consume the secret (agent calls this via MCP tool to get plaintext for injection).
 *
 * SECURITY: This endpoint returns the plaintext ONCE. The caller (runner/tmux handler)
 * MUST NOT log it, return it to the model, or put it in any visible response.
 * The plaintext is injected directly to the destination and then discarded.
 */
secureInputRoutes.post("/:instanceId/secure-inputs/:requestId/consume", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const requestId = c.req.param("requestId") ?? "";

	const plaintext = await consumeSecureInput(c.env, requestId, instanceId, uid);
	if (!plaintext) throw new HttpError(404, "Request not found, not ready, expired, or already consumed");

	// Return the plaintext. The MCP layer will NOT log this and will pass it
	// directly to the runner for injection (not to the model or tool result).
	return c.json({ value: plaintext });
});
