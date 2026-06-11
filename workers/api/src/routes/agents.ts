import { Hono } from "hono";
import { HttpError, requireCreator, requireUser } from "../lib/auth.js";
import { verifySession } from "../lib/session.js";
import type { Env } from "../types.js";

export const agentRoutes = new Hono<{ Bindings: Env }>();

interface AgentRow {
	id: string;
	owner_id: string;
	slug: string;
	name: string;
	description: string;
	category: string;
	icon: string;
	icon_bg: string;
	model: string;
	visibility: string;
	status: string;
	worker_name: string | null;
	cron_schedule: string | null;
	created_at: string;
	updated_at: string;
}

interface GithubRun {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	html_url: string;
	head_sha: string;
	created_at: string;
	updated_at: string;
}

async function github(
	env: Env,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	if (!env.GITHUB_TOKEN) throw new HttpError(503, "GitHub deploy token is not configured");
	return fetch(`https://api.github.com${path}`, {
		...init,
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${env.GITHUB_TOKEN}`,
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "proagentstore-api",
			...(init.headers || {}),
		},
	});
}

function repoNameFor(agent: Pick<AgentRow, "slug">): string {
	return agent.slug;
}

async function requireOwnedAgent(
	c: {
		req: { param(k: string): string };
		env: Env;
	},
	session: { uid: string; roles: string[] },
): Promise<AgentRow> {
	const id = c.req.param("id");
	const row = await c.env.DB.prepare("SELECT * FROM agents WHERE (id = ?1 OR slug = ?1)")
		.bind(id)
		.first<AgentRow>();
	if (!row) throw new HttpError(404, "Agent not found");
	if (row.owner_id !== session.uid && !session.roles.includes("admin")) {
		throw new HttpError(403, "Not your agent");
	}
	return row;
}

async function deployStatus(env: Env, agent: AgentRow) {
	const org = env.GITHUB_ORG || "ProAgentStore";
	const repo = repoNameFor(agent);
	if (!env.GITHUB_TOKEN) {
		return {
			configured: false,
			repo,
			org,
			runs: [],
			message: "GitHub deploy token is not configured",
		};
	}
	const res = await github(
		env,
		`/repos/${org}/${repo}/actions/runs?per_page=5`,
	);
	if (res.status === 404) {
		return {
			configured: true,
			repo,
			org,
			runs: [],
			message: "Repository or deploy workflow not found",
		};
	}
	if (!res.ok) {
		return {
			configured: true,
			repo,
			org,
			runs: [],
			message: `GitHub status failed: ${res.status}`,
		};
	}
	const data = (await res.json()) as { workflow_runs?: GithubRun[] };
	return {
		configured: true,
		repo,
		org,
		runs: (data.workflow_runs || []).map((run) => ({
			id: run.id,
			name: run.name,
			status: run.status,
			conclusion: run.conclusion,
			url: run.html_url,
			headSha: run.head_sha,
			createdAt: run.created_at,
			updatedAt: run.updated_at,
		})),
	};
}

/** List agents owned by the current user. Must be before /:id to avoid shadowing. */
agentRoutes.get("/my/agents", async (c) => {
	const session = await requireUser(c);
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM agents WHERE owner_id = ?1 ORDER BY updated_at DESC`,
	)
		.bind(session.uid)
		.all<AgentRow>();
	return c.json({ agents: results });
});

/** Agent operations status: billing, runtime, deployment. */
agentRoutes.get("/:id/ops", async (c) => {
	const session = await requireUser(c);
	const agent = await requireOwnedAgent(c, session);

	const cloudflareKey = await c.env.DB.prepare(
		"SELECT created_at, last_used_at FROM user_api_keys WHERE user_id = ?1 AND provider = 'cloudflare'",
	)
		.bind(session.uid)
		.first<{ created_at: string; last_used_at: string | null }>();
	const executions = await c.env.DB.prepare(
		`SELECT id, model, duration_ms, error, created_at
     FROM agent_executions
     WHERE agent_id = ?1
     ORDER BY created_at DESC
     LIMIT 5`,
	)
		.bind(agent.id)
		.all();

	return c.json({
		agent: {
			id: agent.id,
			slug: agent.slug,
			name: agent.name,
			model: agent.model || "@cf/meta/llama-3.2-3b-instruct",
			visibility: agent.visibility,
			status: agent.status,
			workerUrl: `https://${agent.slug}.proagentstore.online/`,
		},
		billing: {
			provider: "cloudflare",
			mode: "user-owned",
			hasCloudflareKey: Boolean(cloudflareKey),
			createdAt: cloudflareKey?.created_at || null,
			lastUsedAt: cloudflareKey?.last_used_at || null,
		},
		deploy: await deployStatus(c.env, agent),
		executions: executions.results || [],
	});
});

/** Trigger the GitHub Actions deploy workflow for this agent repo. */
agentRoutes.post("/:id/deploy", async (c) => {
	const session = await requireUser(c);
	const agent = await requireOwnedAgent(c, session);
	const org = c.env.GITHUB_ORG || "ProAgentStore";
	const repo = repoNameFor(agent);

	const res = await github(
		c.env,
		`/repos/${org}/${repo}/actions/workflows/deploy.yml/dispatches`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ref: "main" }),
		},
	);
	if (res.status === 404) {
		const status = await deployStatus(c.env, agent);
		return c.json({
			queued: false,
			message: "Deploy workflow is not available yet",
			deploy: status,
		}, 404);
	}
	if (!res.ok && res.status !== 204) {
		const body = await res.text();
		throw new HttpError(res.status, body || "Deploy trigger failed");
	}
	return c.json({
		queued: true,
		repo,
		org,
		deploy: await deployStatus(c.env, agent),
	});
});

/** List all published agents (public). */
agentRoutes.get("/", async (c) => {
	const category = c.req.query("category");
	const sort = c.req.query("sort") || "newest"; // newest, popular, name
	const limit = Math.min(Number(c.req.query("limit")) || 50, 200);

	let sql = `SELECT a.id, a.slug, a.name, a.description, a.category, a.store_type, a.icon, a.icon_bg, a.model, a.status,
                    u.github_login as creator_login, u.avatar_url as creator_avatar,
                    (SELECT COUNT(*) FROM agent_instances WHERE agent_id = a.id AND status = 'active') as subscriber_count
             FROM agents a LEFT JOIN users u ON u.id = a.owner_id
             WHERE a.visibility = 'published'`;
	const params: unknown[] = [];

	if (category) {
		sql += ` AND a.category = ?${params.length + 1}`;
		params.push(category);
	}

	if (sort === "popular") sql += " ORDER BY subscriber_count DESC, a.created_at DESC";
	else if (sort === "name") sql += " ORDER BY a.name ASC";
	else sql += " ORDER BY a.created_at DESC";

	sql += ` LIMIT ?${params.length + 1}`;
	params.push(limit);

	const stmt = c.env.DB.prepare(sql);
	const { results } = await stmt.bind(...params).all<AgentRow>();
	return c.json({ agents: results });
});

/** Get single agent. Public if published; owners can see their own drafts. */
agentRoutes.get("/:id", async (c) => {
	const id = c.req.param("id");
	const row = await c.env.DB.prepare(
		`SELECT id, owner_id, slug, name, description, category, store_type, icon, icon_bg, model, visibility, status, cron_schedule, created_at, updated_at
     FROM agents WHERE (id = ?1 OR slug = ?1)`,
	)
		.bind(id)
		.first<AgentRow>();
	if (!row) return c.json({ error: "Agent not found" }, 404);

	// Non-published agents require ownership
	const isOwner = await (async () => {
		const header = c.req.header("Authorization");
		if (!header?.startsWith("Bearer ")) return false;
		const session = await verifySession(
			header.slice(7),
			c.env.SESSION_SIGNING_KEY,
		);
		return (
			session &&
			(row.owner_id === session.uid || session.roles.includes("admin"))
		);
	})();

	if (row.visibility !== "published" && !isOwner) {
		return c.json({ error: "Agent not found" }, 404);
	}

	// Strip owner_id for non-owners
	const { owner_id, ...publicFields } = row;
	return c.json(isOwner ? row : publicFields);
});

/** Create agent (requires creator role). */
agentRoutes.post("/", async (c) => {
	const session = await requireCreator(c);
	const body = await c.req.json<{
		slug: string;
		name: string;
		description?: string;
		category?: string;
		icon?: string;
		icon_bg?: string;
		model?: string;
		personality?: string;
		goal?: string;
	}>();

	if (!body.slug || !body.name) {
		throw new HttpError(400, "slug and name required");
	}
	if (!/^[a-z0-9-]+$/.test(body.slug)) {
		throw new HttpError(
			400,
			"slug must be lowercase alphanumeric with hyphens",
		);
	}

	// Check slug uniqueness
	const existing = await c.env.DB.prepare(
		"SELECT id FROM agents WHERE slug = ?1",
	)
		.bind(body.slug)
		.first();
	if (existing) throw new HttpError(409, "Agent slug already taken");

	const id = crypto.randomUUID();
	await c.env.DB.prepare(
		`INSERT INTO agents (id, owner_id, slug, name, description, category, icon, icon_bg, model, visibility, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'draft', 'inactive', datetime('now'), datetime('now'))`,
	)
		.bind(
			id,
			session.uid,
			body.slug,
			body.name,
			body.description || "",
			body.category || "general",
			body.icon || "",
			body.icon_bg || "#7c3aed",
			body.model || "",
		)
		.run();

	// Initialize the agent's Durable Object with personality, goal, memory
	const doId = c.env.AGENT.idFromName(id);
	const stub = c.env.AGENT.get(doId);
	await stub.fetch(
		new Request("https://agent/init", {
			method: "POST",
			body: JSON.stringify({
				agentId: id,
				name: body.name,
				personality: body.personality,
				goal: body.goal,
				model: body.model,
			}),
		}),
	);

	return c.json({ id, slug: body.slug }, 201);
});

/** Update agent (owner only). */
agentRoutes.put("/:id", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");

	const row = await c.env.DB.prepare(
		"SELECT owner_id FROM agents WHERE id = ?1",
	)
		.bind(id)
		.first<AgentRow>();
	if (!row) throw new HttpError(404, "Agent not found");
	if (row.owner_id !== session.uid && !session.roles.includes("admin")) {
		throw new HttpError(403, "Not your agent");
	}

	const body = await c.req.json<Record<string, unknown>>();
	const allowed = {
		name: "name",
		description: "description",
		category: "category",
		icon: "icon",
		icon_bg: "icon_bg",
		model: "model",
		visibility: "visibility",
		cron_schedule: "cron_schedule",
	} as const;
	const sets: string[] = ["updated_at = datetime('now')"];
	const params: unknown[] = [];

	for (const [key, column] of Object.entries(allowed)) {
		if (body[key] !== undefined) {
			params.push(body[key]);
			sets.push(`${column} = ?${params.length + 1}`);
		}
	}

	if (sets.length === 1) throw new HttpError(400, "Nothing to update");

	params.unshift(id); // ?1
	const sql = ["UPDATE agents SET", sets.join(", "), "WHERE id = ?1"].join(" ");
	await c.env.DB.prepare(sql)
		.bind(...params)
		.run();
	return c.json({ success: true });
});

/** Clone/fork a published agent as your own draft. */
agentRoutes.post("/:id/clone", async (c) => {
	const session = await requireCreator(c);
	const id = c.req.param("id");
	const { slug } = await c.req.json<{ slug: string }>();
	if (!slug) throw new HttpError(400, "slug required for cloned agent");
	if (!/^[a-z0-9-]+$/.test(slug)) throw new HttpError(400, "slug must be lowercase alphanumeric with hyphens");

	// Source agent must exist
	const source = await c.env.DB.prepare(
		"SELECT id, name, description, category, store_type, icon, icon_bg, model FROM agents WHERE (id = ?1 OR slug = ?1) AND visibility = 'published'",
	).bind(id).first<Record<string, string>>();
	if (!source) throw new HttpError(404, "Agent not found");

	// Check slug uniqueness
	const existing = await c.env.DB.prepare("SELECT id FROM agents WHERE slug = ?1").bind(slug).first();
	if (existing) throw new HttpError(409, "Slug already taken");

	const newId = crypto.randomUUID();
	await c.env.DB.prepare(
		`INSERT INTO agents (id, owner_id, slug, name, description, category, store_type, icon, icon_bg, model, visibility, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'draft', 'inactive', datetime('now'), datetime('now'))`,
	).bind(
		newId, session.uid, slug, `${source.name} (clone)`, source.description,
		source.category, source.store_type || "agent", source.icon, source.icon_bg, source.model,
	).run();

	// Copy template DO state + KB to the new agent's DO
	const srcStub = c.env.AGENT.get(c.env.AGENT.idFromName(source.id));
	const stateRes = await srcStub.fetch(new Request("https://agent/state"));
	const tmpl = await stateRes.json() as Record<string, unknown>;

	const newStub = c.env.AGENT.get(c.env.AGENT.idFromName(newId));
	await newStub.fetch(new Request("https://agent/init", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			agentId: newId, name: tmpl.name || source.name,
			personality: tmpl.personality || "", goal: tmpl.goal || "",
			model: tmpl.model || source.model, guardrails: tmpl.guardrails || {},
		}),
	}));

	// Copy KB
	const kbRes = await srcStub.fetch(new Request("https://agent/knowledge"));
	const kb = await kbRes.json() as { documents?: Array<Record<string, unknown>> };
	if (kb.documents?.length) {
		for (const doc of kb.documents) {
			await newStub.fetch(new Request("https://agent/knowledge", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(doc),
			}));
		}
	}

	return c.json({ id: newId, slug, clonedFrom: source.id }, 201);
});

/** Delete agent (owner only). */
agentRoutes.delete("/:id", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");

	const row = await c.env.DB.prepare(
		"SELECT owner_id FROM agents WHERE id = ?1",
	)
		.bind(id)
		.first<AgentRow>();
	if (!row) throw new HttpError(404, "Agent not found");
	if (row.owner_id !== session.uid && !session.roles.includes("admin")) {
		throw new HttpError(403, "Not your agent");
	}

	await c.env.DB.batch([
		c.env.DB.prepare("DELETE FROM agent_executions WHERE agent_id = ?1").bind(
			id,
		),
		c.env.DB.prepare("DELETE FROM usage WHERE agent_id = ?1").bind(id),
		c.env.DB.prepare("DELETE FROM agents WHERE id = ?1").bind(id),
	]);
	return c.json({ success: true });
});
