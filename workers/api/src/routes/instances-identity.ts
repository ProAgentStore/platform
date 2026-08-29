/**
 * Owner-initiated identity resync — brings an existing instance's personality up to the
 * current seed without touching guardrails, goal, or welcomeMessage (#496 AC2).
 *
 * Instance identity is copied ONCE at subscribe and stored in the DO. A seed migration
 * that patches `agents.config.identity.personality` fixes the catalog for future subscribers
 * but leaves every live instance unchanged — the gap `instance-copied-config.ts` documents.
 * For DO-held state no migration can write the fix; the only reach path is code that resolves
 * it live, or an owner who presses this.
 *
 * What this route does:
 *   1. Reads the seed personality from the same source subscribe uses: the template DO when
 *      a creator has initialised it, falling back to `agents.config.identity.personality`.
 *   2. Issues a PATCH-only PUT to the instance DO: `{ personality }` alone.
 *      `handleUpdateState` in agent-do.ts is field-gated (`if (updates.personality !=
 *      undefined) state.personality = …`), so guardrails, goal, welcomeMessage and model are
 *      left where the subscriber put them.
 *
 * POST /:instanceId/resync-identity
 *   Body: optional `{ dry_run: true }` — returns the seed personality without writing it.
 *   Response: `{ personality, previous, changed, dryRun? }`.
 *
 * Limit: owner-scoped (`requireOwnedInstance`). Cannot be called on an agent you do not own.
 */
import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

export function registerIdentityResyncRoutes(router: Hono<{ Bindings: Env }>): void {
	router.post("/:instanceId/resync-identity", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);

		// Read the agent config, needed for both the identity fallback AND to reach the template DO.
		const row = await c.env.DB.prepare(
			`SELECT a.id AS agent_id, a.model, a.config
			 FROM agent_instances i JOIN agents a ON a.id = i.agent_id
			 WHERE i.id = ?1 AND i.user_id = ?2`,
		)
			.bind(instanceId, session.uid)
			.first<{ agent_id: string; model: string; config: string | null }>();
		if (!row) throw new HttpError(404, "Instance not found");

		// Replicate the subscribe-time identity resolution: template DO wins when it is
		// initialised; agents.config.identity is the fallback for first-party seed agents.
		const templateDoId = c.env.AGENT.idFromName(row.agent_id);
		const templateStub = c.env.AGENT.get(templateDoId);
		const stateRes = await templateStub.fetch(new Request("https://agent/state"));
		const templateState = (await stateRes.json()) as Record<string, unknown>;
		const templateInited = Boolean(templateState.name) && !templateState.error;

		let seedPersonality = "";
		if (templateInited && typeof templateState.personality === "string") {
			seedPersonality = templateState.personality;
		} else if (row.config) {
			try {
				const parsed = JSON.parse(row.config) as Record<string, unknown>;
				const identity = parsed.identity as Record<string, unknown> | undefined;
				if (typeof identity?.personality === "string") {
					seedPersonality = identity.personality;
				}
			} catch {
				// leave empty — no seed personality to apply
			}
		}

		if (!seedPersonality) {
			return c.json({ error: "This agent has no seed personality to sync from." }, 404);
		}

		// Read the current instance personality to report `changed` and `previous`.
		const instanceDoId = c.env.AGENT.idFromName(instanceId);
		const instanceStub = c.env.AGENT.get(instanceDoId);
		const instanceStateRes = await instanceStub.fetch(new Request("https://agent/state"));
		const instanceState = (await instanceStateRes.json()) as Record<string, unknown>;
		const previous = typeof instanceState.personality === "string" ? instanceState.personality : "";

		const changed = previous !== seedPersonality;

		const body = (await c.req.json().catch(() => ({}))) as { dry_run?: boolean };
		if (body.dry_run) {
			return c.json({ personality: seedPersonality, previous, changed, dryRun: true });
		}

		if (!changed) {
			return c.json({ personality: seedPersonality, previous, changed: false });
		}

		// Write ONLY the personality — field-gated in handleUpdateState so guardrails/goal/
		// welcomeMessage are untouched.
		await instanceStub.fetch(
			new Request("https://agent/state", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ personality: seedPersonality }),
			}),
		);

		return c.json({ personality: seedPersonality, previous, changed: true });
	});
}
