import type { Context, Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { getGmailScoutConfig, gmailScoutSourceMode, putGmailScoutConfig } from "../lib/gmail-scout/config.js";
import { gmailScoutStatus, scanGmailScout } from "../lib/gmail-scout/scan.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

/** The inbox scanner is a dedicated Scout source, never a generic mailbox reader for any agent. */
export async function requireGmailScoutInstance(env: Env, instance: { agent_id: string; config: string }): Promise<void> {
	if (gmailScoutSourceMode(instance.config)) return;
	const agent = await env.DB.prepare("SELECT config FROM agents WHERE id = ?1").bind(instance.agent_id).first<{ config: string | null }>();
	if (gmailScoutSourceMode(agent?.config)) return;
	throw new HttpError(409, "This instance is not configured as a Gmail Job Search Scout source.");
}

/**
 * Configuring the dedicated source is the owner's explicit consent to read its one mailbox.
 * Keep this scoped to the dedicated source route: generic Gmail-capable agents still require the
 * Settings permission toggle, while an MCP-only Scout setup must not dead-end before its first
 * read-only scan.
 */
async function enableGmailScoutEmailPermission(env: Env, instanceId: string): Promise<void> {
	const stub = env.AGENT.get(env.AGENT.idFromName(instanceId));
	const res = await stub.fetch(new Request("https://agent/state", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ permissions: { email: true } }),
	}));
	if (!res.ok) throw new HttpError(503, "Could not enable read-only Gmail access for this Scout.");
}

export function registerGmailScoutRoutes(router: Hono<{ Bindings: Env }>): void {
	const owned = async (c: Context<{ Bindings: Env }>) => {
		const s = await requireUser(c);
		const instanceId = c.req.param("instanceId") ?? "";
		const instance = await requireOwnedInstance(c.env, instanceId, s.uid);
		await requireGmailScoutInstance(c.env, instance);
		return { instanceId, uid: s.uid };
	};
	router.get("/:instanceId/gmail-scout/config", async (c) => c.json({ config: await getGmailScoutConfig(c.env, (await owned(c)).instanceId) }));
	router.put("/:instanceId/gmail-scout/config", async (c) => {
		const { instanceId, uid } = await owned(c);
		const b = await c.req.json().catch(() => ({})) as { pinnedEmail?: unknown; enabled?: unknown };
		if (b.pinnedEmail !== undefined && b.pinnedEmail !== null && typeof b.pinnedEmail !== "string") throw new HttpError(400, "pinnedEmail must be a string or null.");
		if (b.enabled !== undefined && typeof b.enabled !== "boolean") throw new HttpError(400, "enabled must be boolean.");
		try {
			const config = await putGmailScoutConfig(c.env, instanceId, uid, { pinnedEmail: b.pinnedEmail as string | null | undefined, enabled: b.enabled as boolean | undefined });
			if (config.enabled) await enableGmailScoutEmailPermission(c.env, instanceId);
			return c.json({ config });
		} catch (error) {
			if (error instanceof HttpError) throw error;
			throw new HttpError(400, error instanceof Error ? error.message : "Could not configure Gmail Scout.");
		}
	});
	router.post("/:instanceId/gmail-scout/scan", async (c) => { const { instanceId, uid } = await owned(c); return c.json({ scan: await scanGmailScout(c.env, instanceId, uid) }); });
	router.get("/:instanceId/gmail-scout/status", async (c) => c.json(await gmailScoutStatus(c.env, (await owned(c)).instanceId, new URL(c.req.url).searchParams)));
}
