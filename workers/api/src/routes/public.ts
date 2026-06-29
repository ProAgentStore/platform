/**
 * Public routes — no auth required.
 * Agent detail, public chat (trial), webhook ingestion.
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError } from "../lib/auth.js";
import type { Env } from "../types.js";

export const publicRoutes = new Hono<{ Bindings: Env }>();

/** Public agent detail — full info for the store detail page. */
publicRoutes.get("/agents/:id", async (c) => {
	const id = c.req.param("id");
	const row = await c.env.DB.prepare(
		`SELECT id, slug, name, description, category, store_type, icon, icon_bg, model, created_at,
            (SELECT COUNT(*) FROM agent_instances WHERE agent_id = agents.id AND status = 'active') as subscriber_count
     FROM agents WHERE (id = ?1 OR slug = ?1) AND visibility = 'published'`,
	)
		.bind(id)
		.first();
	if (!row) throw new HttpError(404, "Agent not found");

	// Track view event (fire-and-forget)
	c.executionCtx.waitUntil(
		c.env.DB.prepare(
			`INSERT INTO usage (id, agent_id, user_id, event, metadata, created_at)
       VALUES (?1, ?2, '', 'view', '{}', datetime('now'))`,
		).bind(crypto.randomUUID(), (row as Record<string, unknown>).id).run().catch(() => {}),
	);

	return c.json(row);
});

/** Developer profile — public page for a creator. */
publicRoutes.get("/developers/:login", async (c) => {
	const login = c.req.param("login");
	const user = await c.env.DB.prepare(
		`SELECT id, github_login, github_name, avatar_url, display_name, bio, website, twitter, roles
     FROM users WHERE github_login = ?1`,
	)
		.bind(login)
		.first();
	if (!user) throw new HttpError(404, "Developer not found");

	const { results: agents } = await c.env.DB.prepare(
		`SELECT id, slug, name, description, category, store_type, icon, icon_bg
     FROM agents WHERE owner_id = ?1 AND visibility = 'published'
     ORDER BY created_at DESC`,
	)
		.bind((user as Record<string, unknown>).id)
		.all();

	return c.json({
		developer: {
			login: (user as Record<string, unknown>).github_login,
			name:
				(user as Record<string, unknown>).display_name ||
				(user as Record<string, unknown>).github_name,
			avatar: (user as Record<string, unknown>).avatar_url,
			bio: (user as Record<string, unknown>).bio,
			website: (user as Record<string, unknown>).website,
			twitter: (user as Record<string, unknown>).twitter,
			roles: JSON.parse(
				((user as Record<string, unknown>).roles as string) || '["user"]',
			),
			agentCount: agents.length,
		},
		agents,
	});
});

/**
 * Public chat — anyone can try a published agent (no auth, no instance).
 * Creates an ephemeral DO keyed by agent+session. Limited to 10 messages.
 */
publicRoutes.post("/agents/:id/try", async (c) => {
	const id = c.req.param("id");
	const { message, sessionId } = await c.req.json<{
		message: string;
		sessionId?: string;
	}>();
	if (!message) throw new HttpError(400, "message required");

	const agent = await c.env.DB.prepare(
		`SELECT id, name, model FROM agents WHERE (id = ?1 OR slug = ?1) AND visibility = 'published'`,
	)
		.bind(id)
		.first<{ id: string; name: string; model: string }>();
	if (!agent) throw new HttpError(404, "Agent not found");

	// Ephemeral session — keyed by agent + client session (or random)
	const sid = sessionId || crypto.randomUUID();
	const doKey = `trial:${agent.id}:${sid}`;
	const doId = c.env.AGENT.idFromName(doKey);
	const stub = c.env.AGENT.get(doId);

	// Ensure initialized (idempotent — init checks if state exists)
	const stateRes = await stub.fetch(new Request("https://agent/state"));
	if (stateRes.status === 404) {
		// Copy template state
		const templateStub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));
		const templateRes = await templateStub.fetch(
			new Request("https://agent/state"),
		);
		const tmpl = (await templateRes.json()) as Record<string, unknown>;

		await stub.fetch(
			new Request("https://agent/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					agentId: doKey,
					name: tmpl.name || agent.name || "Agent",
					personality: tmpl.personality || "",
					goal: tmpl.goal || "",
					model: tmpl.model || agent.model,
					guardrails: tmpl.guardrails || {},
					welcomeMessage: tmpl.welcomeMessage || "",
				}),
			}),
		);

		// Copy template knowledge base
		const kbRes = await templateStub.fetch(
			new Request("https://agent/knowledge"),
		);
		const kb = (await kbRes.json()) as {
			documents?: Array<Record<string, unknown>>;
		};
		if (kb.documents?.length) {
			for (const doc of kb.documents) {
				await stub.fetch(
					new Request("https://agent/knowledge", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(doc),
					}),
				);
			}
		}
	}

	// Check message limit for trial
	const msgsRes = await stub.fetch(
		new Request("https://agent/messages?limit=20"),
	);
	const msgs = (await msgsRes.json()) as { messages?: unknown[] };
	if ((msgs.messages?.length || 0) >= 20) {
		return c.json(
			{
				error: "Trial limit reached. Subscribe to continue chatting.",
				sessionId: sid,
			},
			429,
		);
	}

	const doRes = await stub.fetch(
		new Request("https://agent/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message, channel: "trial", agentId: doKey, agentName: agent.name }),
		}),
	);

	const data = (await doRes.json()) as Record<string, unknown>;
	return c.json(
		{ ...data, sessionId: sid },
		(doRes.ok ? 200 : doRes.status) as ContentfulStatusCode,
	);
});

/** Google Docs import — fetch a public Google Doc and add to agent KB. */
publicRoutes.post("/agents/:id/import-gdoc", async (c) => {
	const auth = c.req.header("Authorization");
	if (!auth?.startsWith("Bearer ")) throw new HttpError(401, "Auth required");
	const { verifySession } = await import("../lib/session.js");
	const session = await verifySession(auth.slice(7), c.env.SESSION_SIGNING_KEY);
	if (!session) throw new HttpError(401, "Invalid token");

	const { docUrl } = await c.req.json<{ docUrl: string }>();
	if (!docUrl) throw new HttpError(400, "docUrl required");

	const match = docUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
	if (!match) throw new HttpError(400, "Invalid Google Docs URL. Expected: https://docs.google.com/document/d/...");
	const docId = match[1];

	// Fetch as plain text (works for publicly shared docs)
	const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
	const res = await fetch(exportUrl, { headers: { "User-Agent": "ProAgentStore-Ingest" } });
	if (!res.ok) throw new HttpError(400, `Failed to fetch doc (${res.status}). Make sure it's publicly accessible (Anyone with link → Viewer).`);

	let text = await res.text();
	if (text.length > 100_000) text = `${text.slice(0, 100_000)}\n...[truncated]`;

	// Get title from HTML export
	let title = `Google Doc ${docId.slice(0, 8)}`;
	try {
		const htmlRes = await fetch(`https://docs.google.com/document/d/${docId}/export?format=html`);
		if (htmlRes.ok) {
			const html = await htmlRes.text();
			const titleMatch = html.match(/<title>([^<]+)<\/title>/);
			if (titleMatch) title = titleMatch[1];
		}
	} catch { /* title fallback is fine */ }

	const id = c.req.param("id");
	const agent = await c.env.DB.prepare(
		"SELECT id, owner_id FROM agents WHERE (id = ?1 OR slug = ?1)",
	).bind(id).first<{ id: string; owner_id: string }>();
	if (!agent) throw new HttpError(404, "Agent not found");
	// SECURITY: only the owner (or an admin) may write to an agent's canonical KB.
	// Without this any authenticated user could inject documents into another
	// creator's knowledge base (RAG/system-context poisoning). Mirrors resolveAgent
	// in routes/storage.ts.
	if (agent.owner_id !== session.uid && !session.roles.includes("admin")) {
		throw new HttpError(403, "Not your agent");
	}

	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));
	const doRes = await stub.fetch(new Request("https://agent/knowledge", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title, content: text, source: "google-docs", sourceUrl: docUrl }),
	}));

	return c.json(await doRes.json(), 201);
});

/**
 * Webhook ingestion — POST docs to an instance's knowledge base.
 * Used by Zapier, Zoho, Make, n8n, etc.
 * Auth: Bearer token (instance owner's PAGS session token).
 */
publicRoutes.post("/webhook/:instanceId/ingest", async (c) => {
	const instanceId = c.req.param("instanceId");
	const auth = c.req.header("Authorization");
	if (!auth?.startsWith("Bearer "))
		throw new HttpError(401, "Bearer token required");

	const { verifySession } = await import("../lib/session.js");
	const session = await verifySession(auth.slice(7), c.env.SESSION_SIGNING_KEY);
	if (!session) throw new HttpError(401, "Invalid token");

	const instance = await c.env.DB.prepare(
		"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2 AND status = 'active'",
	)
		.bind(instanceId, session.uid)
		.first();
	if (!instance) throw new HttpError(404, "Instance not found");

	const body = await c.req.json<{
		title: string;
		content: string;
		source?: string;
		sourceUrl?: string;
	}>();
	if (!body.title || !body.content)
		throw new HttpError(400, "title and content required");

	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
	const doRes = await stub.fetch(
		new Request("https://agent/knowledge", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: body.title,
				content: body.content,
				source: body.source || "webhook",
				sourceUrl: body.sourceUrl,
			}),
		}),
	);

	return c.json(
		await doRes.json(),
		(doRes.ok ? 201 : doRes.status) as ContentfulStatusCode,
	);
});
