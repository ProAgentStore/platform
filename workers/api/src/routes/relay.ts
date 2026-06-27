import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { verifySession } from "../lib/session.js";
import type { Env } from "../types.js";

export const relayRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /v1/relay/:instanceId/connect?token=TOKEN
 *
 * WebSocket upgrade: validates the bearer token from query param (WS upgrades
 * can't carry Authorization headers in all environments), verifies instance
 * ownership, then forwards to the per-instance RelayDO.
 */
relayRoutes.get("/:instanceId/connect", async (c) => {
	const token = c.req.query("token");
	if (!token) {
		// WS upgrade can't return JSON errors in all clients — return plain HTTP 401
		return new Response("Missing token", { status: 401 });
	}

	const session = await verifySession(token, c.env.SESSION_SIGNING_KEY);
	if (!session) {
		return new Response("Invalid or expired token", { status: 401 });
	}

	const instanceId = c.req.param("instanceId");

	// Verify instance ownership
	const instance = await c.env.DB.prepare(
		"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.first<{ id: string }>();
	if (!instance) return new Response("Instance not found", { status: 404 });

	// Forward to RelayDO (one per instance)
	const stub = c.env.RELAY.get(c.env.RELAY.idFromName(instanceId));
	return stub.fetch(new Request(new URL("/connect", c.req.url), {
		headers: c.req.raw.headers,
	}));
});

/** GET /v1/relay/:instanceId/status -- is a runner WS connected for this instance? */
relayRoutes.get("/:instanceId/status", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");

	// Verify instance ownership
	const instance = await c.env.DB.prepare(
		"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.first<{ id: string }>();
	if (!instance) return c.json({ error: "Instance not found" }, 404);

	const stub = c.env.RELAY.get(c.env.RELAY.idFromName(instanceId));
	const res = await stub.fetch(new Request(new URL("/status", c.req.url)));
	return new Response(res.body, { status: res.status, headers: res.headers });
});
