import { Hono } from "hono";
import { agentDeleteStatements, countAgentSubscribers, foreignSubscriberRefusal, hasForeignSubscriberRows, hasSubscriberRows } from "../lib/agent-cascade.js";
import { customSurfacesEnabled, sanitizeCustomSurfaces, sanitizeDeclaredCapabilities, sanitizeSettingsSchema } from "../lib/agent-capabilities.js";
import { workflowChoices } from "../lib/agent-workflows.js";
import { lintResolvedAgentClaims } from "../lib/agent-claims-resolve.js";
import { AI_LEDGER_FOR_AGENT } from "./analytics.js";
import { HttpError, isSuspended, requireCreator, requireUser } from "../lib/auth.js";
import { verifySession } from "../lib/session.js";
import type { Env } from "../types.js";
import { blockPublishReason } from "../lib/test-agent-guard.js";

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
	// Moves off `agent_executions` with the analytics card (#451), and shares that route's exact
	// predicate rather than copying it: two readers of "what has this agent run" that phrase the
	// question differently is how they end up disagreeing about the answer. `duration_ms` and
	// `error` are dropped — the ledger records neither, and this list has no renderer today (the
	// console's Ops tab is still a stub), so nulling them would only document a measurement nobody
	// takes. Live `error` reporting belongs to `error_log` (migration 0103) / the `/trace` route.
	const executions = await c.env.DB.prepare(
		`SELECT id, model, kind, created_at ${AI_LEDGER_FOR_AGENT}
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

	// `a.status` is deliberately NOT selected (#590). Nine seed migrations write `'active'` and no
	// application code writes it at all, so the public catalogue was handing every caller a field
	// whose only real content was "first-party or not": `status:"active"` for the nine seeded
	// agents beside `status:"inactive"` for every agent a third-party creator could ever build.
	// The store never rendered it; it was a structural distinction leaking through a SELECT list.
	let sql = `SELECT a.id, a.slug, a.name, a.description, a.category, a.store_type, a.icon, a.icon_bg, a.model,
                    CASE WHEN instr(COALESCE(u.github_login, ''), '@') = 0 THEN u.github_login ELSE NULL END as creator_login,
                    COALESCE(NULLIF(u.display_name, ''), NULLIF(u.github_name, ''), CASE WHEN instr(COALESCE(u.github_login, ''), '@') = 0 THEN u.github_login ELSE 'Creator' END) as creator_name,
                    u.avatar_url as creator_avatar,
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

	// Non-published agents require ownership.
	//
	// Auth is OPTIONAL here — an anonymous caller must still get the published view — so
	// `requireUser`, which throws, cannot be used. That means the suspension gate is applied by
	// hand, exactly as the WS chat upgrade does it (#273); without it a suspended creator keeps
	// owner-level visibility of their unpublished agents and their own owner_id. Guarded by
	// security-invariants.test.ts (#306).
	const isOwner = await (async () => {
		const header = c.req.header("Authorization");
		if (!header?.startsWith("Bearer ")) return false;
		const session = await verifySession(
			header.slice(7),
			c.env.SESSION_SIGNING_KEY,
		);
		if (!session) return false;
		if (await isSuspended(c, session.uid)) return false;
		return row.owner_id === session.uid || session.roles.includes("admin");
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
		capabilities?: unknown;
		settingsSchema?: unknown;
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

	// Declarative capabilities at creation (#141): a Coder-equivalent can be stamped out
	// as pure data — {surfaces,runtime,workflow,tools} — with no platform code change.
	// Validated against the closed enums; customSurfaces keeps its own route.
	//
	// settingsSchema is accepted HERE too, not only via its dedicated PUT. An agent whose
	// behaviour is entirely declared is not usable until its subscriber settings exist, so
	// splitting them across two calls meant "create an agent from a client" was really
	// "create, then remember to also…" — and a half-declared agent looks fine and does
	// nothing. Stored at the TOP level, which is where agent-capabilities.ts reads it;
	// nested under capabilities it parses and renders nothing.
	const declaredCaps = sanitizeDeclaredCapabilities(body.capabilities);
	const declaredSettings = body.settingsSchema === undefined ? null : sanitizeSettingsSchema(body.settingsSchema);
	const initialConfig: Record<string, unknown> = {};
	if (Object.keys(declaredCaps).length > 0) initialConfig.capabilities = declaredCaps;
	if (declaredSettings && declaredSettings.length > 0) initialConfig.settingsSchema = declaredSettings;
	if (Object.keys(initialConfig).length > 0) {
		await c.env.DB.prepare("UPDATE agents SET config = ?1 WHERE id = ?2")
			.bind(JSON.stringify(initialConfig), id)
			.run();
	}

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

	// Catalog claims lint (#66): loudly (but non-blockingly) warn when the description promises a
	// runtime capability the declared capabilities can't back — the creator should wire the
	// capability or rewrite the copy before publishing.
	//
	// Against the RESOLVED capabilities (#362), not the declared block alone: `agentCapabilities`
	// falls back to the slug/category derivation for pre-registry agents, so a create with
	// `category: "code"` and honest copy about a local runner is backed and must not be accused.
	// The update path now makes the identical call — one rule, two doors.
	const claimWarnings = lintResolvedAgentClaims({
		description: body.description,
		slug: body.slug,
		// The value that was INSERTed, not the raw body — the fallback derivation keys off it.
		category: body.category || "general",
		config: JSON.stringify(initialConfig),
	});

	return c.json(claimWarnings.length ? { id, slug: body.slug, warnings: claimWarnings } : { id, slug: body.slug }, 201);
});

/** Update agent (owner only). */
agentRoutes.put("/:id", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");

	// `category` and `config` come along for the claims lint (#362): it needs the capabilities as
	// they will stand AFTER this patch, and the capabilities branch below already had to read the
	// config a second time to merge into it.
	const row = await c.env.DB.prepare(
		"SELECT owner_id, slug, name, description, category, config FROM agents WHERE id = ?1",
	)
		.bind(id)
		.first<AgentRow & { category: string | null; config: string | null }>();
	if (!row) throw new HttpError(404, "Agent not found");
	if (row.owner_id !== session.uid && !session.roles.includes("admin")) {
		throw new HttpError(403, "Not your agent");
	}

	const body = await c.req.json<Record<string, unknown>>();

	// Don't let a smoke-test fixture reach the public catalog by accident (#65). Checked
	// against the values AFTER this update, so renaming "Smoke Test Agent" → a real product
	// name and publishing in one call works. Create is unaffected: it always inserts 'draft'.
	const blocked = blockPublishReason(
		{
			slug: row.slug,
			name: typeof body.name === "string" ? body.name : row.name,
			description: typeof body.description === "string" ? body.description : row.description,
		},
		typeof body.visibility === "string" ? body.visibility : undefined,
		body.allowTestAgent === true,
	);
	if (blocked) throw new HttpError(400, blocked);
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

	// Declarative-capabilities update path (#141 wired create; this is the matching
	// update). Patch-merge the validated power fields (surfaces/runtime/workflow/tools)
	// into config.capabilities, preserving sibling keys other routes own (customSurfaces).
	// Only keys present in the body change. Runtime/workflow trust-gating is #142.
	// The config as it will stand after this call — the lint below reads it whether or not the
	// capabilities were touched, because a copy-only edit is exactly the case #362 is about.
	let resolvedConfig = row.config;
	if ("capabilities" in body) {
		const declaredCaps = sanitizeDeclaredCapabilities(body.capabilities);
		let config: Record<string, unknown> = {};
		try { config = row.config ? (JSON.parse(row.config) as Record<string, unknown>) : {}; } catch { config = {}; }
		const caps = (config.capabilities && typeof config.capabilities === "object" ? config.capabilities : {}) as Record<string, unknown>;
		Object.assign(caps, declaredCaps);
		config.capabilities = caps;
		resolvedConfig = JSON.stringify(config);
		params.push(resolvedConfig);
		sets.push(`config = ?${params.length + 1}`);
	}

	if (sets.length === 1) throw new HttpError(400, "Nothing to update");

	params.unshift(id); // ?1
	const sql = ["UPDATE agents SET", sets.join(", "), "WHERE id = ?1"].join(" ");
	await c.env.DB.prepare(sql)
		.bind(...params)
		.run();

	// Catalog claims lint (#66, wired here by #362). Create ran it and update did not, which is
	// backwards: a description is rewritten far more often than it is first written, so the path
	// where the copy actually changes was the path with no check. Against the POST-patch values
	// on both sides, so it catches the mismatch arrived at from either direction — new copy over
	// old capabilities, or new capabilities under old copy.
	//
	// Advisory, exactly as on create: the write has already happened and the warnings ride
	// alongside the success. The heuristic is overridable by design (#66) and blocking on it
	// would make a store's copy editor fight a regex.
	const claimWarnings = lintResolvedAgentClaims({
		description: typeof body.description === "string" ? body.description : row.description,
		slug: row.slug,
		category: typeof body.category === "string" ? body.category : row.category,
		config: resolvedConfig,
	});
	return c.json(claimWarnings.length ? { success: true, warnings: claimWarnings } : { success: true });
});

/** Read the agent's declared custom surfaces (owner only). */
agentRoutes.get("/:id/capabilities", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");
	const row = await c.env.DB.prepare("SELECT owner_id, config FROM agents WHERE (id = ?1 OR slug = ?1)")
		.bind(id)
		.first<{ owner_id: string; config: string | null }>();
	if (!row) throw new HttpError(404, "Agent not found");
	if (row.owner_id !== session.uid && !session.roles.includes("admin")) {
		throw new HttpError(403, "Not your agent");
	}
	let customSurfaces: unknown = [];
	let surfaces: unknown = [];
	let runtime: unknown = null;
	let workflow: unknown = null;
	let tools: unknown = [];
	try {
		const config = row.config ? (JSON.parse(row.config) as Record<string, unknown>) : {};
		const caps = config.capabilities as Record<string, unknown> | undefined;
		customSurfaces = Array.isArray(caps?.customSurfaces) ? caps.customSurfaces : [];
		surfaces = Array.isArray(caps?.surfaces) ? caps.surfaces : [];
		runtime = caps?.runtime ?? null;
		workflow = caps?.workflow ?? null;
		tools = Array.isArray(caps?.tools) ? caps.tools : [];
	} catch { /* malformed config */ }
	// Report the gate so the creator editor can say "this feature is off" instead of letting a
	// creator author a surface that will never render and never be told why (#186).
	//
	// `workflowOptions` is the picker's whole vocabulary, served from the same catalog the
	// sanitizer validates against (#375). The console used to hold its own `<option>` list, which
	// drifted both ways at once — it offered INSURANCE_QUOTES, bound to nothing, and omitted
	// BROWSER_TASK, the only value the platform enforces. Annotated for THIS agent, so a stored
	// value the platform no longer runs comes back visible instead of silently reading as "none".
	return c.json({ customSurfaces, surfaces, runtime, workflow, tools, workflowOptions: workflowChoices(workflow), customSurfacesEnabled: customSurfacesEnabled(c.env) });
});

/** Declare the agent's custom (published) console surfaces — owner only. Stored in
 *  config.capabilities.customSurfaces; the console loads each bundle dynamically. */
agentRoutes.put("/:id/capabilities", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");
	// slug/category/description ride along for the claims lint below (#362) — this route is the
	// other door onto the same mismatch: capabilities change here while the copy stays put.
	const row = await c.env.DB.prepare("SELECT owner_id, slug, category, description, config FROM agents WHERE id = ?1")
		.bind(id)
		.first<{ owner_id: string; slug: string | null; category: string | null; description: string | null; config: string | null }>();
	if (!row) throw new HttpError(404, "Agent not found");
	if (row.owner_id !== session.uid && !session.roles.includes("admin")) {
		throw new HttpError(403, "Not your agent");
	}
	const body = (await c.req.json().catch(() => ({}))) as { customSurfaces?: unknown } & Record<string, unknown>;
	let config: Record<string, unknown> = {};
	try { config = row.config ? (JSON.parse(row.config) as Record<string, unknown>) : {}; } catch { config = {}; }
	const caps = (config.capabilities && typeof config.capabilities === "object" ? config.capabilities : {}) as Record<string, unknown>;

	// customSurfaces load as CODE into the console origin — only overwrite when the key is
	// present (so a capabilities-only PATCH doesn't wipe them), and require a bundle URL on a
	// platform host. Shares the READ path's sanitizer rather than re-implementing it. The two had
	// already drifted (this one trimmed, the other did not), and only one of them knew about
	// reserved ids — so whichever validator you happened not to look at was the one that let a
	// tab-shadowing surface through.
	//
	// With the feature gated off (the default, #186) an attempt to declare surfaces is REFUSED
	// rather than silently sanitized to `[]` — silently storing an empty array would also wipe
	// whatever an operator had declared while the flag was on, and silence is exactly the
	// no-feedback failure this ticket called out.
	if (Array.isArray(body.customSurfaces)) {
		if (!customSurfacesEnabled(c.env)) {
			throw new HttpError(400, "Custom surfaces are disabled on this platform — a surface bundle runs as code in the console origin and the isolation model is not finished. See docs/custom-surfaces.md.");
		}
		caps.customSurfaces = sanitizeCustomSurfaces(body.customSurfaces, c.env) ?? [];
	}

	// The declarative power fields (#141) — closed-enum validated, merged per-key so an
	// editor can PATCH just what it changed.
	const declared = sanitizeDeclaredCapabilities(body);
	if (declared.surfaces !== undefined) caps.surfaces = declared.surfaces;
	if ("runtime" in declared) caps.runtime = declared.runtime;
	if ("workflow" in declared) caps.workflow = declared.workflow;
	if (declared.tools !== undefined) caps.tools = declared.tools;

	config.capabilities = caps;
	const resolvedConfig = JSON.stringify(config);
	await c.env.DB.prepare("UPDATE agents SET config = ?1, updated_at = datetime('now') WHERE id = ?2")
		.bind(resolvedConfig, id)
		.run();
	// Dropping `runtime` here silently turns honest catalog copy into an overclaim, so the same
	// advisory lint the other two doors run reports it (#362). Warnings only — this route's job
	// is to store what the creator declared.
	const claimWarnings = lintResolvedAgentClaims({ description: row.description, slug: row.slug, category: row.category, config: resolvedConfig });
	return c.json({
		customSurfaces: caps.customSurfaces ?? [],
		surfaces: caps.surfaces ?? [],
		runtime: caps.runtime ?? null,
		workflow: caps.workflow ?? null,
		tools: caps.tools ?? [],
		// Re-served on the write path too, so a save that clears a no-longer-runnable value also
		// clears the row the editor was showing for it (#375).
		workflowOptions: workflowChoices(caps.workflow),
		customSurfacesEnabled: customSurfacesEnabled(c.env),
		...(claimWarnings.length ? { warnings: claimWarnings } : {}),
	});
});

/** Read the agent's declared subscriber-settings schema (owner only). */
agentRoutes.get("/:id/settings-schema", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");
	const row = await c.env.DB.prepare("SELECT owner_id, config FROM agents WHERE (id = ?1 OR slug = ?1)")
		.bind(id)
		.first<{ owner_id: string; config: string | null }>();
	if (!row) throw new HttpError(404, "Agent not found");
	if (row.owner_id !== session.uid && !session.roles.includes("admin")) {
		throw new HttpError(403, "Not your agent");
	}
	let settingsSchema: unknown = [];
	try {
		const config = row.config ? (JSON.parse(row.config) as Record<string, unknown>) : {};
		settingsSchema = sanitizeSettingsSchema(config.settingsSchema) ?? [];
	} catch { /* malformed config */ }
	return c.json({ settingsSchema });
});

/** Declare the agent's subscriber-settings schema — owner only. Stored at TOP-LEVEL
 *  config.settingsSchema (sibling of capabilities); subscribers set values on their
 *  instance's Settings tab and the chat prompt reads them as a `## Settings` block. */
agentRoutes.put("/:id/settings-schema", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");
	const row = await c.env.DB.prepare("SELECT owner_id, config FROM agents WHERE id = ?1")
		.bind(id)
		.first<{ owner_id: string; config: string | null }>();
	if (!row) throw new HttpError(404, "Agent not found");
	if (row.owner_id !== session.uid && !session.roles.includes("admin")) {
		throw new HttpError(403, "Not your agent");
	}
	const body = (await c.req.json().catch(() => ({}))) as { settingsSchema?: unknown };
	const settingsSchema = sanitizeSettingsSchema(body.settingsSchema) ?? [];
	let config: Record<string, unknown> = {};
	try { config = row.config ? (JSON.parse(row.config) as Record<string, unknown>) : {}; } catch { config = {}; }
	config.settingsSchema = settingsSchema;
	await c.env.DB.prepare("UPDATE agents SET config = ?1, updated_at = datetime('now') WHERE id = ?2")
		.bind(JSON.stringify(config), id)
		.run();
	return c.json({ settingsSchema });
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

/**
 * Delete agent (owner only).
 *
 * The cascade itself lives in `lib/agent-cascade.ts` and is shared with `routes/batch.ts` and
 * `routes/admin-moderation.ts` — the three lists had drifted to three different sets of child
 * tables, which is how a saved version could make THIS route fail on a foreign key while bulk
 * delete succeeded (#646).
 *
 * The policy is this route's own. A creator may take their own template down, including their own
 * instances of it, but an instance belonging to somebody else is that subscriber's workspace, and
 * a delete here must not destroy it — so this refuses with a 409 that says how many and what to do
 * instead. Until #646 that case was a raw D1 constraint message in the console's `alert()`, which
 * is the same refusal with none of the information.
 */
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

	// Scoped to the AGENT'S owner, not the caller: an admin reaching this route on somebody else's
	// agent gets the same refusal, and is pointed at the audited operator route rather than being
	// handed a silent cross-tenant delete on the strength of a role baked into a 30-day token.
	const counts = await countAgentSubscribers(c.env.DB, id, row.owner_id);
	if (hasForeignSubscriberRows(counts)) throw new HttpError(409, foreignSubscriberRefusal(counts));

	await c.env.DB.batch(
		agentDeleteStatements(c.env.DB, id, { cascadeSubscribers: hasSubscriberRows(counts) }),
	);
	return c.json({ success: true, deletedInstances: counts.instances });
});
