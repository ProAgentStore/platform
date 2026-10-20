import type { Context, Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { getGmailScoutConfig, gmailScoutSourceMode, putGmailScoutConfig } from "../lib/gmail-scout/config.js";
import { gmailScoutStatus, parseReprocessInput, reprocessGmailScout, scanGmailScout } from "../lib/gmail-scout/scan.js";
import { listGmailScoutReceipts } from "../lib/gmail-scout/receipts.js";
import { readScanLog } from "../lib/gmail-scout/scan-log.js";
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
	/**
	 * "Scan now" (#1023): the scheduler's own scan path, triggered by the owner. Answers the scan and its
	 * durable receipt; a scan already running for this Scout is returned (`reused`) rather than repeated.
	 * A failure still answers its receipt: 409 when the source is disabled, 502 when the mailbox could
	 * not be read. Nothing is handed to the Tailor or Runner.
	 */
	router.post("/:instanceId/gmail-scout/scan", async (c) => {
		const { instanceId, uid } = await owned(c);
		try {
			return c.json({ scan: await scanGmailScout(c.env, instanceId, uid, { trigger: "on_demand", triggeredBy: uid }) });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Gmail scan failed.";
			const [receipt] = await listGmailScoutReceipts(c.env, instanceId, 1);
			return c.json({ error: message, receipt: receipt ?? null }, /not configured or is disabled/.test(message) ? 409 : 502);
		}
	});
	/**
	 * Reprocess historical job mail (#1052): messages the owner names (`messageIds`), or an
	 * `after`/`before` window of at most 30 days — at most 25 messages either way. Same intake as a scan,
	 * the scan cursor untouched, any job that already has an application refused. 400 on a request
	 * outside those bounds; otherwise the same 409/502 + receipt contract as "Scan now".
	 */
	router.post("/:instanceId/gmail-scout/reprocess", async (c) => {
		const { instanceId, uid } = await owned(c);
		const parsed = parseReprocessInput(await c.req.json().catch(() => ({})));
		if (!parsed.ok) throw new HttpError(400, parsed.error);
		try {
			return c.json({ scan: await reprocessGmailScout(c.env, instanceId, uid, parsed.input) });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Gmail reprocess failed.";
			const [receipt] = await listGmailScoutReceipts(c.env, instanceId, 1);
			return c.json({ error: message, receipt: receipt ?? null }, /not configured or is disabled/.test(message) ? 409 : 502);
		}
	});
	router.get("/:instanceId/gmail-scout/status", async (c) => c.json(await gmailScoutStatus(c.env, (await owned(c)).instanceId, new URL(c.req.url).searchParams)));
	/**
	 * One scan's per-message decision log (#1247): which emails it matched (ids + a link that opens each),
	 * what it read, what it took each for and why, and a digest's jobs one by one. `scan_id` omitted reads
	 * the newest scan; `cursor` pages on. Owner-only like every route here; metadata and snippets only.
	 */
	router.get("/:instanceId/gmail-scout/scan-log", async (c) => {
		const { instanceId } = await owned(c);
		const q = new URL(c.req.url).searchParams;
		const page = await readScanLog(c.env, instanceId, { scanId: q.get("scan_id"), cursor: q.get("cursor"), limit: q.has("limit") ? Number(q.get("limit")) : undefined });
		if (!page.scan) throw new HttpError(404, q.get("scan_id") ? "No scan with that id on this Scout." : "This Scout has not scanned yet.");
		return c.json(page);
	});
}
