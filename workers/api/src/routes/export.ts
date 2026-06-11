import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import type { Env } from "../types.js";

export const exportRoutes = new Hono<{ Bindings: Env }>();

/** Export agent config + knowledge as a single JSON backup. */
exportRoutes.get("/:id/export", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");

	const agent = await c.env.DB.prepare(
		"SELECT id, owner_id, slug, name, description, category, store_type, model FROM agents WHERE id = ?1 OR slug = ?1",
	).bind(id).first<Record<string, string>>();
	if (!agent) throw new HttpError(404, "Agent not found");
	if (agent.owner_id !== session.uid && !session.roles.includes("admin")) {
		throw new HttpError(403, "Not your agent");
	}

	// Get DO state
	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));
	const stateRes = await stub.fetch(new Request("https://agent/state"));
	const state = stateRes.ok ? await stateRes.json() : null;

	// Get knowledge base
	const kbRes = await stub.fetch(new Request("https://agent/knowledge"));
	const kb = await kbRes.json() as { documents?: unknown[] };

	// Get memory
	const memRes = await stub.fetch(new Request("https://agent/memory"));
	const mem = await memRes.json() as { memory?: unknown[] };

	return c.json({
		exportVersion: 1,
		exportedAt: new Date().toISOString(),
		agent: {
			slug: agent.slug,
			name: agent.name,
			description: agent.description,
			category: agent.category,
			storeType: agent.store_type,
			model: agent.model,
		},
		state,
		knowledge: kb.documents || [],
		memory: mem.memory || [],
	});
});

/** Import agent config from a JSON backup. Overwrites current state. */
exportRoutes.post("/:id/import", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");

	const agent = await c.env.DB.prepare(
		"SELECT id, owner_id FROM agents WHERE id = ?1 OR slug = ?1",
	).bind(id).first<{ id: string; owner_id: string }>();
	if (!agent) throw new HttpError(404, "Agent not found");
	if (agent.owner_id !== session.uid && !session.roles.includes("admin")) {
		throw new HttpError(403, "Not your agent");
	}

	const backup = await c.req.json<{
		exportVersion?: number;
		agent?: Record<string, string>;
		state?: Record<string, unknown>;
		knowledge?: Array<{ title: string; content: string; source?: string }>;
		memory?: Array<{ key: string; type: string; content: string }>;
	}>();

	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));

	// Restore state
	if (backup.state) {
		await stub.fetch(new Request("https://agent/state", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(backup.state),
		}));
	}

	// Restore knowledge
	let kbCount = 0;
	if (backup.knowledge?.length) {
		for (const doc of backup.knowledge) {
			await stub.fetch(new Request("https://agent/knowledge", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(doc),
			}));
			kbCount++;
		}
	}

	// Restore memory
	let memCount = 0;
	if (backup.memory?.length) {
		for (const m of backup.memory) {
			await stub.fetch(new Request("https://agent/memory", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(m),
			}));
			memCount++;
		}
	}

	// Update D1 fields if provided
	if (backup.agent) {
		const fields = backup.agent;
		const allowed = {
			name: "name",
			description: "description",
			category: "category",
			model: "model",
		} as const;
		const sets: string[] = ["updated_at = datetime('now')"];
		const params: unknown[] = [];
		for (const [key, column] of Object.entries(allowed)) {
			if (fields[key]) {
				params.push(fields[key]);
				sets.push(`${column} = ?${params.length + 1}`);
			}
		}
		if (params.length > 0) {
			params.unshift(agent.id);
			const sql = ["UPDATE agents SET", sets.join(", "), "WHERE id = ?1"].join(" ");
			await c.env.DB.prepare(sql).bind(...params).run();
		}
	}

	return c.json({ success: true, restored: { knowledge: kbCount, memory: memCount, state: !!backup.state } });
});
