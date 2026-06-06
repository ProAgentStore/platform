/**
 * email-drafter — ProAgentStore agent.
 *
 * Generates emails that match your brand voice. Upload brand guidelines,
 * example emails, and tone docs to the knowledge base; then describe what
 * you need and the agent drafts it in your configured voice.
 *
 * Routes
 * ------
 * GET  /                          — health check
 * POST /draft                     — generate a new email draft
 * GET  /drafts                    — list all drafts (optional ?tag= filter)
 * GET  /drafts/:id                — get a single draft
 * POST /knowledge                 — add a brand document to the knowledge base
 * GET  /knowledge                 — list all knowledge base documents
 * DELETE /knowledge/:id           — remove a document
 * GET  /config                    — get brand config
 * PUT  /config                    — update brand config
 */

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

// ── Types ──────────────────────────────────────────────────────────────────

interface Env {
	AI: Ai;
	BRAND_CONFIG: DurableObjectNamespace;
	DRAFT_STORE: DurableObjectNamespace;
	KNOWLEDGE_BASE: DurableObjectNamespace;
	/** Optional bearer token — if set, all requests must send Authorization: Bearer <token> */
	API_SECRET?: string;
}

type Tone = "formal" | "casual" | "friendly" | "persuasive" | "empathetic";

interface BrandConfig {
	tone: Tone;
	signature: string;
	senderName: string;
	/** Common reusable templates stored by name */
	templates: Record<string, string>;
	/** Additional style notes passed verbatim to the AI prompt */
	styleNotes: string;
	updatedAt: string;
}

interface KnowledgeDoc {
	id: string;
	title: string;
	content: string;
	/** e.g. "brand-guidelines", "example-email", "tone-guide" */
	type: string;
	createdAt: string;
}

interface Draft {
	id: string;
	prompt: string;
	subject: string;
	body: string;
	/** Tags provided by caller, e.g. ["welcome", "onboarding"] */
	tags: string[];
	/** Name of template used, if any */
	template?: string;
	/** Tone used when draft was generated */
	tone: Tone;
	createdAt: string;
}

interface DraftRequest {
	prompt: string;
	/** Override the configured tone for this draft */
	tone?: Tone;
	/** Name of a saved template to use as starting structure */
	template?: string;
	/** Optional tags for later filtering */
	tags?: string[];
	/** Optional recipient name for personalisation */
	recipientName?: string;
	/** Optional subject hint */
	subjectHint?: string;
}

interface ConfigUpdateRequest {
	tone?: Tone;
	signature?: string;
	senderName?: string;
	styleNotes?: string;
}

// ── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: BrandConfig = {
	tone: "friendly",
	signature: "",
	senderName: "",
	templates: {},
	styleNotes: "",
	updatedAt: new Date(0).toISOString(),
};

const DRAFT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as Parameters<
	Ai["run"]
>[0];

const VALID_TONES: Tone[] = [
	"formal",
	"casual",
	"friendly",
	"persuasive",
	"empathetic",
];

// ── App ───────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

// ── Auth middleware ───────────────────────────────────────────────────────

app.use("*", async (c, next) => {
	const secret = c.env.API_SECRET;
	if (!secret) return next();
	const auth = c.req.header("authorization") ?? "";
	if (auth !== `Bearer ${secret}`) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	return next();
});

// ── DO helpers ────────────────────────────────────────────────────────────

function getBrandConfig(env: Env): DurableObjectStub {
	return env.BRAND_CONFIG.get(env.BRAND_CONFIG.idFromName("config"));
}

function getDraftStore(env: Env): DurableObjectStub {
	return env.DRAFT_STORE.get(env.DRAFT_STORE.idFromName("store"));
}

function getKnowledgeBase(env: Env): DurableObjectStub {
	return env.KNOWLEDGE_BASE.get(env.KNOWLEDGE_BASE.idFromName("kb"));
}

function doFetch(
	stub: DurableObjectStub,
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return stub.fetch(new Request(`http://internal${path}`, init));
}

// ── Health ────────────────────────────────────────────────────────────────

app.get("/", (c) =>
	c.json({ agent: "email-drafter", type: "agent", status: "ok" }),
);

// ── Config ────────────────────────────────────────────────────────────────

app.get("/config", async (c) => {
	const res = await doFetch(getBrandConfig(c.env), "/config");
	return new Response(res.body, { status: res.status, headers: res.headers });
});

app.put("/config", async (c) => {
	let body: ConfigUpdateRequest;
	try {
		body = await c.req.json<ConfigUpdateRequest>();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	if (body.tone && !VALID_TONES.includes(body.tone)) {
		return c.json(
			{ error: `tone must be one of: ${VALID_TONES.join(", ")}` },
			400,
		);
	}

	const res = await doFetch(getBrandConfig(c.env), "/config", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Templates (sub-resource of config) ───────────────────────────────────

app.post("/config/templates", async (c) => {
	let body: { name: string; content: string };
	try {
		body = await c.req.json<{ name: string; content: string }>();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}
	if (!body.name || !body.content) {
		return c.json({ error: "name and content are required" }, 400);
	}
	const res = await doFetch(getBrandConfig(c.env), "/templates", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return new Response(res.body, { status: res.status, headers: res.headers });
});

app.delete("/config/templates/:name", async (c) => {
	const res = await doFetch(
		getBrandConfig(c.env),
		`/templates/${encodeURIComponent(c.req.param("name"))}`,
		{ method: "DELETE" },
	);
	return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Knowledge base ────────────────────────────────────────────────────────

app.post("/knowledge", async (c) => {
	let body: { title: string; content: string; type?: string };
	try {
		body = await c.req.json<{ title: string; content: string; type?: string }>();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}
	if (!body.title || !body.content) {
		return c.json({ error: "title and content are required" }, 400);
	}

	const doc: KnowledgeDoc = {
		id: crypto.randomUUID(),
		title: body.title,
		content: body.content,
		type: body.type ?? "general",
		createdAt: new Date().toISOString(),
	};

	const res = await doFetch(getKnowledgeBase(c.env), "/docs", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(doc),
	});
	return new Response(res.body, { status: res.status, headers: res.headers });
});

app.get("/knowledge", async (c) => {
	const res = await doFetch(getKnowledgeBase(c.env), "/docs");
	return new Response(res.body, { status: res.status, headers: res.headers });
});

app.delete("/knowledge/:id", async (c) => {
	const res = await doFetch(
		getKnowledgeBase(c.env),
		`/docs/${c.req.param("id")}`,
		{ method: "DELETE" },
	);
	return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Draft generation ──────────────────────────────────────────────────────

app.post("/draft", async (c) => {
	let body: DraftRequest;
	try {
		body = await c.req.json<DraftRequest>();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	if (!body.prompt) {
		return c.json({ error: "prompt is required" }, 400);
	}
	if (body.tone && !VALID_TONES.includes(body.tone)) {
		return c.json(
			{ error: `tone must be one of: ${VALID_TONES.join(", ")}` },
			400,
		);
	}

	// Load config and knowledge base in parallel
	const [configRes, kbRes] = await Promise.all([
		doFetch(getBrandConfig(c.env), "/config"),
		doFetch(getKnowledgeBase(c.env), "/docs"),
	]);

	const config = (await configRes.json()) as BrandConfig;
	const { docs } = (await kbRes.json()) as { docs: KnowledgeDoc[] };

	const tone = body.tone ?? config.tone;
	const templateContent = body.template
		? config.templates[body.template]
		: undefined;

	const { subject, emailBody } = await generateDraft(c.env.AI, {
		prompt: body.prompt,
		tone,
		signature: config.signature,
		senderName: config.senderName,
		styleNotes: config.styleNotes,
		knowledgeDocs: docs,
		templateContent,
		recipientName: body.recipientName,
		subjectHint: body.subjectHint,
	});

	const draft: Draft = {
		id: crypto.randomUUID(),
		prompt: body.prompt,
		subject,
		body: emailBody,
		tags: body.tags ?? [],
		template: body.template,
		tone,
		createdAt: new Date().toISOString(),
	};

	const saveRes = await doFetch(getDraftStore(c.env), "/drafts", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(draft),
	});
	if (!saveRes.ok) {
		return c.json({ error: "Failed to persist draft" }, 500);
	}

	return c.json(draft, 201);
});

// ── Draft retrieval ───────────────────────────────────────────────────────

app.get("/drafts", async (c) => {
	const tag = c.req.query("tag");
	const params = new URLSearchParams();
	if (tag) params.set("tag", tag);
	const res = await doFetch(getDraftStore(c.env), `/drafts?${params}`);
	return new Response(res.body, { status: res.status, headers: res.headers });
});

app.get("/drafts/:id", async (c) => {
	const res = await doFetch(
		getDraftStore(c.env),
		`/drafts/${c.req.param("id")}`,
	);
	return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Error handling ────────────────────────────────────────────────────────

app.onError((err, c) => {
	console.error("Unhandled error:", err.message, err.stack);
	return c.json({ error: "Internal server error" }, 500);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

export default app;

// ── Durable Objects ───────────────────────────────────────────────────────

/**
 * BrandConfigDO — stores brand config and saved templates.
 *
 * Storage layout:
 *   config        → BrandConfig
 *   template:<name> → string (template body)
 */
export class BrandConfigDO extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		try {
			// GET /config
			if (path === "/config" && request.method === "GET") {
				const stored = await this.ctx.storage.get<BrandConfig>("config");
				return json(stored ?? DEFAULT_CONFIG);
			}

			// PUT /config — partial update
			if (path === "/config" && request.method === "PUT") {
				const stored =
					(await this.ctx.storage.get<BrandConfig>("config")) ?? DEFAULT_CONFIG;
				const patch = await request.json<ConfigUpdateRequest>();
				const updated: BrandConfig = {
					...stored,
					...(patch.tone !== undefined && { tone: patch.tone }),
					...(patch.signature !== undefined && { signature: patch.signature }),
					...(patch.senderName !== undefined && {
						senderName: patch.senderName,
					}),
					...(patch.styleNotes !== undefined && {
						styleNotes: patch.styleNotes,
					}),
					updatedAt: new Date().toISOString(),
				};
				await this.ctx.storage.put("config", updated);
				return json(updated);
			}

			// POST /templates — add or overwrite a template
			if (path === "/templates" && request.method === "POST") {
				const { name, content } = await request.json<{
					name: string;
					content: string;
				}>();
				const stored =
					(await this.ctx.storage.get<BrandConfig>("config")) ?? DEFAULT_CONFIG;
				const updated: BrandConfig = {
					...stored,
					templates: { ...stored.templates, [name]: content },
					updatedAt: new Date().toISOString(),
				};
				await this.ctx.storage.put("config", updated);
				return json({ name, saved: true });
			}

			// DELETE /templates/:name
			const tplMatch = path.match(/^\/templates\/([^/]+)$/);
			if (tplMatch && request.method === "DELETE") {
				const name = decodeURIComponent(tplMatch[1]);
				const stored =
					(await this.ctx.storage.get<BrandConfig>("config")) ?? DEFAULT_CONFIG;
				const { [name]: _removed, ...rest } = stored.templates;
				const updated: BrandConfig = {
					...stored,
					templates: rest,
					updatedAt: new Date().toISOString(),
				};
				await this.ctx.storage.put("config", updated);
				return json({ name, deleted: true });
			}

			return json({ error: "Not found" }, 404);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("BrandConfigDO error:", msg);
			return json({ error: msg }, 500);
		}
	}
}

/**
 * DraftStoreDO — persists all generated email drafts.
 *
 * Storage layout:
 *   draft:<id>  → Draft
 */
export class DraftStoreDO extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		try {
			// POST /drafts — save new draft
			if (path === "/drafts" && request.method === "POST") {
				const draft = await request.json<Draft>();
				await this.ctx.storage.put(`draft:${draft.id}`, draft);
				return json(draft, 201);
			}

			// GET /drafts — list, newest first, optional ?tag= filter
			if (path === "/drafts" && request.method === "GET") {
				const tagFilter = url.searchParams.get("tag");
				const all = await this.ctx.storage.list<Draft>({ prefix: "draft:" });
				let drafts = [...all.values()].sort(
					(a, b) =>
						new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
				);
				if (tagFilter) {
					drafts = drafts.filter((d) => d.tags.includes(tagFilter));
				}
				return json({ drafts, total: drafts.length });
			}

			// GET /drafts/:id
			const match = path.match(/^\/drafts\/([^/]+)$/);
			if (match && request.method === "GET") {
				const draft = await this.ctx.storage.get<Draft>(`draft:${match[1]}`);
				if (!draft) return json({ error: "Draft not found" }, 404);
				return json(draft);
			}

			return json({ error: "Not found" }, 404);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("DraftStoreDO error:", msg);
			return json({ error: msg }, 500);
		}
	}
}

/**
 * KnowledgeBaseDO — stores brand documents (guidelines, examples, tone guides).
 *
 * Storage layout:
 *   doc:<id>  → KnowledgeDoc
 */
export class KnowledgeBaseDO extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		try {
			// POST /docs — add document
			if (path === "/docs" && request.method === "POST") {
				const doc = await request.json<KnowledgeDoc>();
				await this.ctx.storage.put(`doc:${doc.id}`, doc);
				return json(doc, 201);
			}

			// GET /docs — list all documents
			if (path === "/docs" && request.method === "GET") {
				const all = await this.ctx.storage.list<KnowledgeDoc>({
					prefix: "doc:",
				});
				const docs = [...all.values()].sort(
					(a, b) =>
						new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
				);
				return json({ docs, total: docs.length });
			}

			// DELETE /docs/:id
			const match = path.match(/^\/docs\/([^/]+)$/);
			if (match && request.method === "DELETE") {
				const key = `doc:${match[1]}`;
				const existing = await this.ctx.storage.get<KnowledgeDoc>(key);
				if (!existing) return json({ error: "Document not found" }, 404);
				await this.ctx.storage.delete(key);
				return json({ id: match[1], deleted: true });
			}

			return json({ error: "Not found" }, 404);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("KnowledgeBaseDO error:", msg);
			return json({ error: msg }, 500);
		}
	}
}

// ── AI generation ─────────────────────────────────────────────────────────

async function generateDraft(
	ai: Ai,
	opts: {
		prompt: string;
		tone: Tone;
		signature: string;
		senderName: string;
		styleNotes: string;
		knowledgeDocs: KnowledgeDoc[];
		templateContent?: string;
		recipientName?: string;
		subjectHint?: string;
	},
): Promise<{ subject: string; emailBody: string }> {
	const toneDescriptions: Record<Tone, string> = {
		formal:
			"professional and formal — use full sentences, no contractions, avoid casual language",
		casual:
			"casual and relaxed — contractions are fine, conversational phrasing, approachable",
		friendly:
			"warm and friendly — personable, enthusiastic but not over the top, conversational",
		persuasive:
			"persuasive — lead with value, use clear calls to action, benefits-focused language",
		empathetic:
			"empathetic and supportive — acknowledge feelings, gentle phrasing, focus on the reader",
	};

	// Build knowledge context (cap at ~4000 chars total to stay within context)
	const kbContext = buildKnowledgeContext(opts.knowledgeDocs, 4000);

	const systemPrompt = `You are an expert email copywriter. You write emails that precisely match a brand's voice and guidelines.

Output ONLY valid JSON in exactly this format — no markdown, no explanation:
{"subject": "<email subject line>", "body": "<full email body including greeting and sign-off>"}

The body should use plain text with line breaks (\\n) for paragraphs. Do not use HTML.`;

	const userPrompt = buildUserPrompt(opts, toneDescriptions, kbContext);

	let subject = "Draft email";
	let emailBody = "Unable to generate draft — please try again.";

	try {
		const result = (await ai.run(DRAFT_MODEL, {
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userPrompt },
			],
		})) as { response?: string };

		const raw = (result.response ?? "").trim();
		const jsonMatch = raw.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = JSON.parse(jsonMatch[0]) as {
				subject?: string;
				body?: string;
			};
			if (parsed.subject) subject = parsed.subject;
			if (parsed.body) emailBody = parsed.body;
		}
	} catch (err) {
		console.error(
			"AI generation failed:",
			err instanceof Error ? err.message : String(err),
		);
	}

	return { subject, emailBody };
}

function buildUserPrompt(
	opts: {
		prompt: string;
		tone: Tone;
		signature: string;
		senderName: string;
		styleNotes: string;
		templateContent?: string;
		recipientName?: string;
		subjectHint?: string;
	},
	toneDescriptions: Record<Tone, string>,
	kbContext: string,
): string {
	const parts: string[] = [];

	parts.push(`Write an email with the following requirements:`);
	parts.push(`\nRequest: ${opts.prompt}`);
	parts.push(`\nTone: ${toneDescriptions[opts.tone]}`);

	if (opts.recipientName) {
		parts.push(`Recipient name: ${opts.recipientName}`);
	}
	if (opts.subjectHint) {
		parts.push(`Subject hint: ${opts.subjectHint}`);
	}
	if (opts.senderName) {
		parts.push(`Sender name: ${opts.senderName}`);
	}
	if (opts.signature) {
		parts.push(
			`End the email with this exact signature:\n${opts.signature}`,
		);
	}
	if (opts.styleNotes) {
		parts.push(`Additional style notes: ${opts.styleNotes}`);
	}
	if (opts.templateContent) {
		parts.push(
			`Use this template as the structural starting point (adapt content to the request):\n${opts.templateContent}`,
		);
	}
	if (kbContext) {
		parts.push(
			`Brand knowledge base (use to match voice and terminology):\n${kbContext}`,
		);
	}

	return parts.join("\n");
}

function buildKnowledgeContext(docs: KnowledgeDoc[], maxChars: number): string {
	if (docs.length === 0) return "";

	const sections: string[] = [];
	let totalChars = 0;

	for (const doc of docs) {
		const section = `[${doc.type.toUpperCase()}] ${doc.title}:\n${doc.content}`;
		if (totalChars + section.length > maxChars) break;
		sections.push(section);
		totalChars += section.length;
	}

	return sections.join("\n\n---\n\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
