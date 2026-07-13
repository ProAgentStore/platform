import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { requirePro } from "../lib/billing.js";
import { normalizeRunnerNode, relayNameForInstance } from "../lib/runtime-nodes.js";
import { signRelayToken, verifyRelayToken } from "../lib/session.js";
import type { Env } from "../types.js";

export const relayRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /v1/relay/:instanceId/token
 *
 * Mint a short-lived, instance-scoped relay token for the WS handshake. The
 * runner calls this (with its account session) before each connect, so the
 * long-lived account JWT never travels in a WebSocket URL.
 */
relayRoutes.post("/:instanceId/token", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const instance = await c.env.DB.prepare(
		"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.first<{ id: string }>();
	if (!instance) return c.json({ error: "Instance not found" }, 404);
	// The runner is Pro-only. This is the REAL enforcement point: relay tokens are
	// short-lived and re-minted on every (re)connect, so a lapsed subscription cuts
	// off at the next connect — no stale-registration loophole.
	await requirePro(c.env, session);
	const { token, exp } = await signRelayToken(instanceId, session.uid, c.env.SESSION_SIGNING_KEY);
	return c.json({ token, expiresAt: new Date(exp * 1000).toISOString() });
});

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

	const instanceId = c.req.param("instanceId");

	// Accept ONLY a short-lived relay token scoped to THIS instance — not the
	// full account session JWT. This is what keeps a leaked relay URL from
	// becoming account/machine takeover.
	const relay = await verifyRelayToken(token, c.env.SESSION_SIGNING_KEY);
	if (!relay || relay.instanceId !== instanceId) {
		return new Response("Invalid or expired token", { status: 401 });
	}

	// Verify instance ownership (defensive — the token already binds uid+instance).
	const instance = await c.env.DB.prepare(
		"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, relay.uid)
		.first<{ id: string }>();
	if (!instance) return new Response("Instance not found", { status: 404 });

	const runnerNode = normalizeRunnerNode(c.req.query("node"));
	// Forward to RelayDO. Legacy/default runners use the instance id; Coder runners
	// pass ?node=<hostname> so multiple machines can stay connected concurrently.
	const doUrl = new URL("/connect", c.req.url);
	if (c.req.query("force") === "1") doUrl.searchParams.set("force", "1");
	const stub = c.env.RELAY.get(c.env.RELAY.idFromName(relayNameForInstance(instanceId, runnerNode)));
	return stub.fetch(new Request(doUrl, {
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

	const runnerNode = normalizeRunnerNode(c.req.query("node"));
	const stub = c.env.RELAY.get(c.env.RELAY.idFromName(relayNameForInstance(instanceId, runnerNode)));
	const res = await stub.fetch(new Request(new URL("/status", c.req.url)));
	return new Response(res.body, { status: res.status, headers: res.headers });
});
