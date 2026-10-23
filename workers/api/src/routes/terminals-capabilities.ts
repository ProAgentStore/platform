import type { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { normalizeMachineId } from "../lib/machine-identity.js";
import { capabilityHistory, getMachineCapabilities, MAX_NEEDS, summarizeCapabilities } from "../lib/machine-capabilities.js";
import { checkCapabilityRequirements } from "../lib/machine-capability-compat.js";
import type { Env } from "../types.js";

/**
 * What a machine can do (#1312), read back: the validated record, a per-engine verdict, and the changes over time.
 * Owner-scoped, keyed by the stable machine id, and answered from the platform's stored record — so it works while
 * the runner is offline, and says plainly when a machine has never reported.
 */
async function ownedMachineId(env: Env, uid: string, raw: string): Promise<string | null> {
	const machineId = normalizeMachineId(raw);
	if (!machineId) return null;
	const row = await env.DB.prepare("SELECT 1 AS x FROM instance_runtime_nodes WHERE user_id = ?1 AND machine_id = ?2 LIMIT 1").bind(uid, machineId).first<{ x: number }>();
	return row ? machineId : null;
}
const NOT_FOUND = "No identified machine is registered under this account.";

export function registerMachineCapabilityRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/machines/:machineId/capabilities", async (c) => {
		const session = await requireUser(c);
		const machineId = await ownedMachineId(c.env, session.uid, c.req.param("machineId"));
		if (!machineId) return c.json({ error: NOT_FOUND }, 404);
		const stored = await getMachineCapabilities(c.env, session.uid, machineId);
		if (!stored) return c.json({ machineId, reported: false, message: "This machine has not reported its capabilities yet. Update the runner (`pags update`) and keep `pags up` running; it reports at startup." });
		const history = c.req.query("history") === "1" ? await capabilityHistory(c.env, session.uid, machineId) : undefined;
		return c.json({ machineId, reported: true, summary: summarizeCapabilities(stored), capabilities: stored.capabilities, ...(history ? { history } : {}) });
	});

	/** Would this machine satisfy these requirements? The same check the job gate runs, without starting anything. */
	router.get("/machines/:machineId/capabilities/check", async (c) => {
		const session = await requireUser(c);
		const machineId = await ownedMachineId(c.env, session.uid, c.req.param("machineId"));
		if (!machineId) return c.json({ error: NOT_FOUND }, 404);
		// Comma-separated in the query, so a read stays a GET: no requirement contains a comma.
		const needs = (c.req.query("needs") ?? "").split(",").map((n) => n.trim()).filter(Boolean);
		if (needs.length === 0 || needs.length > MAX_NEEDS || needs.some((n) => n.length > 60)) {
			return c.json({ error: `needs must be a list of 1-${MAX_NEEDS} requirements, each 1-60 characters (for example webkit, node>=22, wrangler, docker, ios, android).` }, 400);
		}
		const stored = await getMachineCapabilities(c.env, session.uid, machineId);
		const r = checkCapabilityRequirements(stored?.capabilities ?? null, needs);
		return c.json({ machineId, reported: !!stored, satisfied: r.satisfied, failures: r.failures });
	});
}
