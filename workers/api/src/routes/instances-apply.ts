import type { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { listAtsCache } from "../lib/apply-cache.js";
import type { Env } from "../types.js";
import { callRuntime, requireOwnedInstance, requireRuntime, runtimeJson, runtimeStatus } from "./instances-runtime.js";

/** Read the instance's JSON config (client-side settings incl. specialInstructions). */
export async function readInstanceConfig(env: Env, instanceId: string, userId: string): Promise<Record<string, unknown>> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, userId).first<{ config: string }>();
	try {
		return JSON.parse(row?.config || "{}") as Record<string, unknown>;
	} catch {
		return {};
	}
}

/**
 * The apply-pipeline support routes: human-takeover proxies (frame/input/resume/
 * end), Special Instructions CRUD, learned per-ATS tips, and the ask-and-hold
 * value channel. Split out of instances.ts to keep that file focused. The heavy
 * `/apply` trigger itself stays in instances.ts next to task creation.
 */
export function registerApplyRoutes(router: Hono<{ Bindings: Env }>): void {
	/** List active human-takeover sessions on my instance's runtime. */
	router.get("/:instanceId/takeover", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const runtime = await requireRuntime(c.env, instanceId, session.uid);
		const res = await callRuntime(c.env, runtime, "/takeover");
		return c.json((await runtimeJson(res)) as object, runtimeStatus(res, 200));
	});

	/** Live JPEG frame of a paused (needs_human) task's browser page. */
	router.get("/:instanceId/takeover/:taskId/frame", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const taskId = c.req.param("taskId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const runtime = await requireRuntime(c.env, instanceId, session.uid);
		const res = await callRuntime(c.env, runtime, `/takeover/${encodeURIComponent(taskId)}/frame`);
		return c.json((await runtimeJson(res)) as object, runtimeStatus(res, 200));
	});

	/** Relay a human's mouse/keyboard input into the taken-over page. */
	router.post("/:instanceId/takeover/:taskId/input", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const taskId = c.req.param("taskId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const runtime = await requireRuntime(c.env, instanceId, session.uid);
		const body = await c.req.text();
		const res = await callRuntime(c.env, runtime, `/takeover/${encodeURIComponent(taskId)}/input`, { method: "POST", body });
		return c.json((await runtimeJson(res)) as object, runtimeStatus(res, 200));
	});

	/** Resume after a human solved the challenge — re-check + submit. */
	router.post("/:instanceId/takeover/:taskId/resume", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const taskId = c.req.param("taskId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const runtime = await requireRuntime(c.env, instanceId, session.uid);
		const res = await callRuntime(c.env, runtime, `/takeover/${encodeURIComponent(taskId)}/resume`, { method: "POST" });
		return c.json((await runtimeJson(res)) as object, runtimeStatus(res, 200));
	});

	/** Read the instance's special instructions (rules the agent must follow). */
	router.get("/:instanceId/instructions", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const cfg = await readInstanceConfig(c.env, instanceId, session.uid);
		return c.json({ instructions: typeof cfg.specialInstructions === "string" ? cfg.specialInstructions : "" });
	});

	/** Update the instance's special instructions. */
	router.put("/:instanceId/instructions", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as { instructions?: unknown };
		const cfg = await readInstanceConfig(c.env, instanceId, session.uid);
		cfg.specialInstructions = String(body.instructions ?? "").slice(0, 4000);
		await c.env.DB.prepare("UPDATE agent_instances SET config = ?1, updated_at = datetime('now') WHERE id = ?2 AND user_id = ?3")
			.bind(JSON.stringify(cfg), instanceId, session.uid)
			.run();
		return c.json({ ok: true });
	});

	/** The agent's learned per-ATS tips (what worked + failed) — full transparency. */
	router.get("/:instanceId/apply-tips", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		return c.json({ tips: await listAtsCache(c.env, session.uid) });
	});

	/** Supply the value the apply agent asked for (ask-and-hold / needs_input handoff). */
	router.post("/:instanceId/input", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const runtime = await requireRuntime(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as { taskId?: string; value?: string };
		if (!body.taskId) return c.json({ error: "taskId required" }, 400);
		const res = await callRuntime(c.env, runtime, "/browser/input", {
			method: "POST",
			body: JSON.stringify({ taskId: body.taskId, value: String(body.value ?? "") }),
		});
		return c.json((await runtimeJson(res)) as object, runtimeStatus(res, 200));
	});

	/** End a human-takeover session. */
	router.post("/:instanceId/takeover/:taskId/end", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const taskId = c.req.param("taskId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const runtime = await requireRuntime(c.env, instanceId, session.uid);
		const res = await callRuntime(c.env, runtime, `/takeover/${encodeURIComponent(taskId)}/end`, { method: "POST" });
		return c.json((await runtimeJson(res)) as object, runtimeStatus(res, 200));
	});
}
