import type { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { normalizeMachineId } from "../lib/machine-identity.js";
import { enqueueWatchdogCommand, readWatchdog, watchdogHeartbeat } from "../lib/machine-watchdog.js";
import type { Env } from "../types.js";

/**
 * The always-on control channel (#1320), owner-scoped like every machine route: a machine id this account has registered, reached with
 * the account's own session — the same credential the runner uses. The watchdog calls `heartbeat`; the owner (console, MCP) reads the
 * status and queues commands. Queuing only validates a closed set of command kinds; the watchdog is what runs them.
 */
async function ownedMachineId(env: Env, uid: string, raw: string): Promise<string | null> {
	const machineId = normalizeMachineId(raw);
	if (!machineId) return null;
	const row = await env.DB.prepare("SELECT 1 AS x FROM instance_runtime_nodes WHERE user_id = ?1 AND machine_id = ?2 LIMIT 1").bind(uid, machineId).first<{ x: number }>();
	return row ? machineId : null;
}
const NOT_FOUND = "No identified machine is registered under this account.";

export function registerMachineWatchdogRoutes(router: Hono<{ Bindings: Env }>): void {
	router.post("/machines/:machineId/watchdog/heartbeat", async (c) => {
		const session = await requireUser(c);
		const machineId = await ownedMachineId(c.env, session.uid, c.req.param("machineId"));
		if (!machineId) return c.json({ error: NOT_FOUND }, 404);
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		return c.json({ success: true, ...(await watchdogHeartbeat(c.env, session.uid, machineId, body)) });
	});

	router.get("/machines/:machineId/watchdog", async (c) => {
		const session = await requireUser(c);
		const machineId = await ownedMachineId(c.env, session.uid, c.req.param("machineId"));
		if (!machineId) return c.json({ error: NOT_FOUND }, 404);
		return c.json({ machineId, ...(await readWatchdog(c.env, session.uid, machineId)) });
	});

	router.post("/machines/:machineId/watchdog/commands", async (c) => {
		const session = await requireUser(c);
		const machineId = await ownedMachineId(c.env, session.uid, c.req.param("machineId"));
		if (!machineId) return c.json({ error: NOT_FOUND }, 404);
		const body = (await c.req.json().catch(() => null)) as { kind?: unknown; args?: unknown } | null;
		const w = await readWatchdog(c.env, session.uid, machineId);
		if (!w.installed) return c.json({ error: "This machine has no watchdog yet. Run `pags watchdog install` on it (or let `pags up` as a service install it), then queue the command." }, 409);
		const r = await enqueueWatchdogCommand(c.env, session.uid, machineId, body?.kind, body?.args);
		return r.ok ? c.json({ command: r.command, duplicate: r.duplicate, connected: w.connected }, r.duplicate ? 200 : 201) : c.json({ error: r.error }, 400);
	});
}
