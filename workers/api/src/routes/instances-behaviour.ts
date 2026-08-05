import type { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import {
	BEHAVIOUR_FIELDS,
	applyBehaviourPatch,
	describeBehaviour,
	resolveBehaviour,
	sanitizeBehaviour,
} from "../lib/agent-behaviour.js";
import { readInstanceConfig } from "./instances-apply.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

/**
 * Agent Behaviour routes (#223).
 *
 * The stored object is deliberately SPARSE — only fields the user has actually touched. `GET`
 * therefore returns the resolved values and the schema separately rather than a filled-in object:
 * the console needs to know which fields are set (so it can show "using the platform default")
 * and a merged blob cannot express that.
 */
export function registerBehaviourRoutes(router: Hono<{ Bindings: Env }>): void {
	/**
	 * The field table itself.
	 *
	 * Served rather than duplicated in the console build, so labels, bands and the prompt prose the
	 * UI displays are literally the strings the prompt is assembled from. Public: it is a static
	 * description of the product with nothing user-specific in it.
	 */
	router.get("/behaviour-schema", (c) => c.json({ fields: BEHAVIOUR_FIELDS }));

	/** Resolved behaviour for one instance: creator default merged under the subscriber's override. */
	router.get("/:instanceId/behaviour", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const cfg = await readInstanceConfig(c.env, instanceId, session.uid);
		const agentCfg = await readAgentConfig(c.env, instanceId);
		const resolved = resolveBehaviour(agentCfg.behaviour, cfg.behaviour);
		return c.json({
			behaviour: resolved,
			// What the creator shipped, so the UI can say "back to the agent's default" honestly
			// instead of implying an unset field means the platform default.
			templateDefault: sanitizeBehaviour(agentCfg.behaviour).behaviour,
			described: describeBehaviour(resolved),
		});
	});

	/**
	 * Patch semantics, matching every other settings route on the platform.
	 *
	 * `null` for a field CLEARS it (back to unset), which is distinct from an empty string — a
	 * cleared field stops contributing to the prompt entirely, where `""` on a text field is
	 * already the same thing but reachable by a user who just emptied the box. Both work.
	 */
	router.put("/:instanceId/behaviour", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as { behaviour?: unknown };
		const patch = (body.behaviour ?? {}) as Record<string, unknown>;

		const cfg = await readInstanceConfig(c.env, instanceId, session.uid);
		// No allowlist: this is the owner editing their own agent in the UI, so guardrails are
		// theirs to set. The allowlist exists for the agent's own tool (#224), not for the human.
		const { behaviour: next, rejected } = applyBehaviourPatch(cfg.behaviour, patch);

		cfg.behaviour = next;
		await c.env.DB.prepare(
			"UPDATE agent_instances SET config = ?1, updated_at = datetime('now') WHERE id = ?2 AND user_id = ?3",
		)
			.bind(JSON.stringify(cfg), instanceId, session.uid)
			.run();
		// Rejections are reported, never swallowed — a half-applied patch that reports success is
		// how a caller ends up believing it set something it did not.
		return c.json({ behaviour: next, rejected, described: describeBehaviour(next) });
	});

	/** Clear everything — back to the platform's own heuristics. */
	router.delete("/:instanceId/behaviour", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const cfg = await readInstanceConfig(c.env, instanceId, session.uid);
		delete cfg.behaviour;
		await c.env.DB.prepare(
			"UPDATE agent_instances SET config = ?1, updated_at = datetime('now') WHERE id = ?2 AND user_id = ?3",
		)
			.bind(JSON.stringify(cfg), instanceId, session.uid)
			.run();
		return c.json({ ok: true, behaviour: {} });
	});
}

/** The creator's template default, via the instance's agent_id. Best-effort — never blocks a read. */
async function readAgentConfig(env: Env, instanceId: string): Promise<Record<string, unknown>> {
	try {
		const row = await env.DB.prepare(
			"SELECT a.config AS config FROM agent_instances i LEFT JOIN agents a ON a.id = i.agent_id WHERE i.id = ?1",
		)
			.bind(instanceId)
			.first<{ config: string | null }>();
		return row?.config ? (JSON.parse(row.config) as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}
