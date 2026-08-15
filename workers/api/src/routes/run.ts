import { Hono } from "hono";
import { HttpError, isAdmin, requireUser } from "../lib/auth.js";
import {
	runUserWorkersAi,
	UserAiCredentialsError,
	UserAiProviderError,
} from "../lib/user-ai.js";
import type { Env } from "../types.js";

export const runRoutes = new Hono<{ Bindings: Env }>();

interface AgentRow {
	id: string;
	slug: string;
	name: string;
	model: string;
	visibility: string;
	owner_id: string;
}

/**
 * May this caller run this agent? (#219, corrected by #590)
 *
 * The original check was `visibility !== "published" && status !== "active"`, which rejects only
 * an agent failing BOTH conditions. Two independent requirements need AND, so #219 made it AND.
 *
 * `status` was the wrong second requirement, and #219's own comment records the belief that made
 * it look right: "a DRAFT agent with status 'active' (the state every agent sits in while its
 * creator builds it)". No agent has ever sat in that state. All three `INSERT INTO agents` write
 * `'inactive'`, the update allowlist does not contain `status`, and no `UPDATE agents` anywhere
 * sets it — only nine seed migrations write `'active'`, and `'error'` has no writer at all. So
 * the AND was a gate on a field nothing could open: every third-party published agent 404'd for
 * every non-owner, permanently, and 404 reads as "missing" rather than "not activated" (#590).
 *
 * `visibility` is now the whole public gate, which is what the rest of this Worker already
 * believed: the catalogue query is `WHERE a.visibility = 'published'`, `GET /v1/agents/:id`
 * requires ownership only when not published, and the clone source lookup takes
 * `AND visibility = 'published'`. This endpoint was the single outlier, so it is the outlier that
 * changes.
 *
 * Deliberately NOT the other repair — making publish write `status = 'active'`. That gives one
 * fact two encodings in two columns, and a second encoding drifts: #587, in this same batch, is
 * `instance_runtimes.status` disagreeing with the heartbeat it was supposed to summarise. The
 * declared vocabulary `inactive | active | error` is a HEALTH vocabulary — `error` is not a
 * publication state — and nothing in this platform computes an agent's health. A field the
 * system does not compute must not gate access to it.
 *
 * `privileged` = the owner or an admin: they may run their own work in any state, which is the
 * creator workflow this endpoint exists for.
 */
export function canRunAgent(a: { visibility: string; privileged: boolean }): boolean {
	if (a.privileged) return true;
	return a.visibility === "published";
}

/** Execute an agent — runs Workers AI with the agent's config. */
runRoutes.post("/:id/run", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");

	const agent = await c.env.DB.prepare(
		`SELECT id, slug, name, model, visibility, owner_id FROM agents WHERE (id = ?1 OR slug = ?1)`,
	)
		.bind(id)
		.first<AgentRow>();

	if (!agent) throw new HttpError(404, "Agent not found");

	// Access gate (#219, corrected by #590 — see `canRunAgent`). A non-owner needs the agent
	// PUBLISHED; the `status === "active"` half was a gate on a column no application code can
	// write, so it closed the platform to third-party creators entirely.
	//
	// The owner (and an admin) may run their own work in any state — that is the creator
	// workflow this endpoint exists for. 404 rather than 403 for a non-owner: whether a private
	// draft exists under a guessed slug is itself information the creator has not published.
	const isOwner = agent.owner_id === session.uid;
	const privileged = isOwner || (await isAdmin(c, session));
	if (!canRunAgent({ visibility: agent.visibility, privileged })) {
		throw new HttpError(404, "Agent not found");
	}

	// Deliberately NOT gated on a subscription. This endpoint runs ONE inference against the
	// agent's declared model using the CALLER's own AI credentials (runUserWorkersAi below,
	// keyed on session.uid); it touches none of the agent's instance state, knowledge or tools,
	// and the caller pays for it. The entitlement boundary is the instance — subscribe, and the
	// instance routes enforce ownership. Putting a paywall here would also break the SDK's
	// pro.ts callers without protecting anything the marketplace actually sells.
	const body = await c.req.json<{ input: Record<string, unknown> }>();
	if (!body.input) throw new HttpError(400, "input required");

	const model = agent.model || "@cf/meta/llama-3.2-3b-instruct";
	const startMs = Date.now();

	let result: unknown;
	try {
		result = await runUserWorkersAi(c.env, session.uid, model, body.input, { kind: "run", agentId: agent.id });
	} catch (err) {
		if (err instanceof UserAiCredentialsError) {
			throw new HttpError(err.status, err.message);
		}
		if (err instanceof UserAiProviderError) {
			throw new HttpError(err.status, err.message);
		}
		throw err;
	}

	const durationMs = Date.now() - startMs;

	// Log execution
	const execId = crypto.randomUUID();
	await c.env.DB.prepare(
		`INSERT INTO agent_executions (id, agent_id, user_id, model, input_tokens, output_tokens, duration_ms, created_at)
     VALUES (?1, ?2, ?3, ?4, 0, 0, ?5, datetime('now'))`,
	)
		.bind(execId, agent.id, session.uid, model, durationMs)
		.run();

	// Track usage for creator payouts
	await c.env.DB.prepare(
		`INSERT INTO usage (id, agent_id, user_id, event, metadata, created_at)
     VALUES (?1, ?2, ?3, 'execution', ?4, datetime('now'))`,
	)
		.bind(
			crypto.randomUUID(),
			agent.id,
			session.uid,
			JSON.stringify({ model, durationMs }),
		)
		.run();

	return c.json({ result, executionId: execId, durationMs });
});

/** Get execution history for an agent. */
runRoutes.get("/:id/executions", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");
	const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
	// Resolve slug→UUID — agent_executions.agent_id stores the UUID, so binding the raw
	// param (a slug in the normal case) silently returned an empty history.
	const agent = await c.env.DB.prepare("SELECT id FROM agents WHERE id = ?1 OR slug = ?1").bind(id).first<{ id: string }>();
	if (!agent) return c.json({ executions: [] });

	const { results } = await c.env.DB.prepare(
		`SELECT id, model, input_tokens, output_tokens, duration_ms, created_at
     FROM agent_executions WHERE agent_id = ?1 AND user_id = ?2
     ORDER BY created_at DESC LIMIT ?3`,
	)
		.bind(agent.id, session.uid, limit)
		.all();

	return c.json({ executions: results });
});
