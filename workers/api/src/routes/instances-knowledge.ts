import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError, requireUser } from "../lib/auth.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

/**
 * The instance knowledge base (#305) — the subscriber's OWN documents, as opposed to the
 * template KB copied in at subscribe time.
 *
 * WHY THIS IS ONE MODULE. Six routes, every one of them the same two moves: prove the caller owns
 * the instance, then proxy to that instance's AgentDO at `https://agent/knowledge…`. There is no
 * business logic here at all — which is the point. Gathered, the ONE thing these routes actually
 * decide is visible in a screenful: whether the tenant gate is spelled `requireOwnedInstance` (the
 * two console-editor routes) or as an inline `SELECT id FROM agent_instances WHERE id = ?1 AND
 * user_id = ?2` (the other four). Scattered through 1700 lines, that inconsistency read as noise.
 * `instances.contract.test.ts` drives all six with a session that owns nothing and pins that both
 * spellings answer 404, so the difference is cosmetic rather than a hole waiting to be found.
 */
export function registerKnowledgeRoutes(router: Hono<{ Bindings: Env }>): void {
	/** Add knowledge to my instance (client's own docs). */
	router.post("/:instanceId/knowledge", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");

		const instance = await c.env.DB.prepare(
			"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
		)
			.bind(instanceId, session.uid)
			.first();
		if (!instance) throw new HttpError(404, "Instance not found");

		const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
		const doRes = await stub.fetch(
			new Request("https://agent/knowledge", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(await c.req.json()),
			}),
		);
		return c.json(
			await doRes.json(),
			(doRes.ok ? 201 : doRes.status) as ContentfulStatusCode,
		);
	});

	/** Delete a doc from my instance's knowledge base. */
	router.delete("/:instanceId/knowledge/:docId", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");

		const instance = await c.env.DB.prepare(
			"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
		)
			.bind(instanceId, session.uid)
			.first();
		if (!instance) throw new HttpError(404, "Instance not found");

		const docId = c.req.param("docId");
		const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
		const doRes = await stub.fetch(
			new Request(`https://agent/knowledge/${encodeURIComponent(docId)}`, { method: "DELETE" }),
		);
		return c.json(await doRes.json());
	});

	/** Read one document's full content (console viewer/editor). */
	router.get("/:instanceId/knowledge/:docId", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
		const doRes = await stub.fetch(new Request(`https://agent/knowledge/${encodeURIComponent(c.req.param("docId"))}`));
		return c.json(await doRes.json(), doRes.status as ContentfulStatusCode);
	});

	/** Edit a document's title/content (console editor). */
	router.put("/:instanceId/knowledge/:docId", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
		const doRes = await stub.fetch(new Request(`https://agent/knowledge/${encodeURIComponent(c.req.param("docId"))}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(await c.req.json()),
		}));
		return c.json(await doRes.json(), doRes.status as ContentfulStatusCode);
	});

	/** Import URL into my instance's knowledge base. */
	router.post("/:instanceId/knowledge/ingest-url", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");

		const instance = await c.env.DB.prepare(
			"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
		)
			.bind(instanceId, session.uid)
			.first();
		if (!instance) throw new HttpError(404, "Instance not found");

		const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
		const doRes = await stub.fetch(
			new Request("https://agent/knowledge/ingest-url", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(await c.req.json()),
			}),
		);
		return c.json(
			await doRes.json(),
			(doRes.ok ? 201 : doRes.status) as ContentfulStatusCode,
		);
	});

	/** Get my instance's knowledge base. */
	router.get("/:instanceId/knowledge", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");

		const instance = await c.env.DB.prepare(
			"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
		)
			.bind(instanceId, session.uid)
			.first();
		if (!instance) throw new HttpError(404, "Instance not found");

		const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
		const doRes = await stub.fetch(new Request("https://agent/knowledge"));
		return c.json(await doRes.json());
	});
}
