import type { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { BEHAVIOUR_FIELDS, describeBehaviour, resolveBehaviour, sanitizeBehaviour } from "../lib/agent-behaviour.js";
import { patchBehaviour, readBehaviour } from "../lib/behaviour-store.js";
import { readInstanceConfig } from "./instances-apply.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";
import { removeInstanceConfigKey } from "../lib/instance-config.js";

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

		// No allowlist: this is the owner editing their own agent in the UI, so guardrails are
		// theirs to set. The allowlist exists for the agent's own tool (#224), not for the human.
		// Returns the RESOLVED behaviour, matching GET — the console replaces its state with this,
		// and an override-only reply made every creator-supplied default vanish from the page.
		const { behaviour: next, rejected } = await patchBehaviour(c.env, instanceId, session.uid, patch);
		const agentCfg = await readAgentConfig(c.env, instanceId);
		// Rejections are reported, never swallowed — a half-applied patch that reports success is
		// how a caller ends up believing it set something it did not.
		return c.json({
			behaviour: next,
			// Same shape as GET (#232). The console replaces its whole state from this response, so
			// omitting the creator's default left it comparing new values against a stale one — and
			// a field the CREATOR set would go back to offering a "reset" that clears nothing.
			templateDefault: sanitizeBehaviour(agentCfg.behaviour).behaviour,
			rejected,
			described: describeBehaviour(next),
		});
	});

	/** Clear everything — back to the platform's own heuristics. */
	router.delete("/:instanceId/behaviour", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		// Remove just this key (#231). set_behaviour is a tool the AGENT calls, so a reset can
		// race a save the owner is making in another tab; a whole-blob write dropped the loser.
		await removeInstanceConfigKey(c.env, instanceId, session.uid, "behaviour");
		// Not `{}` — clearing the subscriber's override falls back to the creator's default, which
		// may well be non-empty. Reporting {} would show the page as unconfigured while the agent
		// still had a character.
		return c.json({
			ok: true,
			behaviour: await readBehaviour(c.env, instanceId, session.uid),
			templateDefault: sanitizeBehaviour((await readAgentConfig(c.env, instanceId)).behaviour).behaviour,
		});
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
