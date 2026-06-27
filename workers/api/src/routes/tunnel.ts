import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { deleteTunnel, getUserTunnel, namedTunnelConfigured, provisionTunnel } from "../lib/cf-tunnel.js";
import type { Env } from "../types.js";

/**
 * Named tunnel provisioning routes. The CLI calls these to get a stable,
 * production-grade tunnel instead of a flaky quick tunnel.
 *
 * Flow:
 *   1. CLI calls POST /v1/tunnel/provision
 *   2. API creates a CF named tunnel (if not exists), configures ingress + DNS
 *   3. Returns the connector token
 *   4. CLI runs `cloudflared tunnel run --token <TOKEN>`
 *   5. Stable hostname: runner-{slug}.proagentstore.online — no URL churn
 */
export const tunnelRoutes = new Hono<{ Bindings: Env }>();

/** Is the named tunnel infrastructure configured on this deployment? */
tunnelRoutes.get("/status", (c) => c.json({ configured: namedTunnelConfigured(c.env) }));

/** Provision (or return existing) named tunnel for the authenticated user. */
tunnelRoutes.post("/provision", async (c) => {
	const session = await requireUser(c);
	if (!namedTunnelConfigured(c.env)) {
		return c.json({ error: "Named tunnels not configured on this deployment. Use quick tunnels (--tunnel quick)." }, 503);
	}
	try {
		const info = await provisionTunnel(c.env, session.uid);
		return c.json({
			tunnelId: info.tunnelId,
			tunnelName: info.tunnelName,
			hostname: info.hostname,
			connectorToken: info.connectorToken,
			endpointUrl: `https://${info.hostname}`,
		});
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
	}
});

/** Get the user's tunnel info (without the token — for status display). */
tunnelRoutes.get("/info", async (c) => {
	const session = await requireUser(c);
	const tunnel = await getUserTunnel(c.env, session.uid);
	if (!tunnel) return c.json({ provisioned: false });
	return c.json({
		provisioned: true,
		tunnelId: tunnel.tunnelId,
		hostname: tunnel.hostname,
		endpointUrl: `https://${tunnel.hostname}`,
		status: tunnel.status,
	});
});

/** Delete the user's named tunnel (cleanup). */
tunnelRoutes.delete("/", async (c) => {
	const session = await requireUser(c);
	const ok = await deleteTunnel(c.env, session.uid);
	return c.json({ ok });
});
