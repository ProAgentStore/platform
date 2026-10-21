import type { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { parseThresholdPatch, readMachineThresholds, resetMachineThresholds, setMachineThresholds, thresholdsView } from "../lib/machine-thresholds.js";
import { normalizeMachineId } from "../lib/machine-identity.js";
import { machineNodeNames } from "../lib/runner-admission-gate.js";
import { latestResourceSample } from "../lib/runner-resources.js";
import type { Env } from "../types.js";

/**
 * The machine's admission thresholds (#1275): what the gate judges it against, where each came from, and its verdict now.
 * Owner-scoped and keyed by the stable machine id, like the policy above; it works while the runner is offline.
 */
async function machineThresholdsAnswer(env: Env, uid: string, machineId: string) {
	const [{ overrides, state }, names] = await Promise.all([readMachineThresholds(env, uid, machineId), machineNodeNames(env, uid, machineId)]);
	const sample = await latestResourceSample(env, uid, names);
	return { machineId, ...thresholdsView(env, overrides, state, sample ? { cpus: sample.cpus, memTotalBytes: sample.memTotalBytes } : null) };
}

/** 404 unless this account has a machine under that id. */
async function ownedMachineId(env: Env, uid: string, raw: string): Promise<string | null> {
	const machineId = normalizeMachineId(raw);
	if (!machineId) return null;
	const row = await env.DB.prepare("SELECT 1 AS x FROM instance_runtime_nodes WHERE user_id = ?1 AND machine_id = ?2 LIMIT 1").bind(uid, machineId).first<{ x: number }>();
	return row ? machineId : null;
}

export function registerMachineThresholdRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/machines/:machineId/thresholds", async (c) => {
		const session = await requireUser(c);
		const machineId = await ownedMachineId(c.env, session.uid, c.req.param("machineId"));
		if (!machineId) return c.json({ error: "No identified machine is registered under this account." }, 404);
		return c.json(await machineThresholdsAnswer(c.env, session.uid, machineId));
	});

	/** Partial update: a number sets a threshold, null puts it back to the default, absent leaves it. */
	router.put("/machines/:machineId/thresholds", async (c) => {
		const session = await requireUser(c);
		const machineId = await ownedMachineId(c.env, session.uid, c.req.param("machineId"));
		if (!machineId) return c.json({ error: "No identified machine is registered under this account." }, 404);
		const checked = parseThresholdPatch(await c.req.json().catch(() => null));
		if ("error" in checked) return c.json({ error: checked.error }, 400);
		const before = (await readMachineThresholds(c.env, session.uid, machineId)).overrides;
		await setMachineThresholds(c.env, session.uid, machineId, checked.patch);
		return c.json({ ...(await machineThresholdsAnswer(c.env, session.uid, machineId)), changed: checked.patch, before });
	});

	/** Remove every override: the machine goes back to the defaults and the cores/memory session formula. */
	router.delete("/machines/:machineId/thresholds", async (c) => {
		const session = await requireUser(c);
		const machineId = await ownedMachineId(c.env, session.uid, c.req.param("machineId"));
		if (!machineId) return c.json({ error: "No identified machine is registered under this account." }, 404);
		const before = (await readMachineThresholds(c.env, session.uid, machineId)).overrides;
		await resetMachineThresholds(c.env, session.uid, machineId);
		return c.json({ ...(await machineThresholdsAnswer(c.env, session.uid, machineId)), reset: true, before });
	});
}
