/**
 * content-pipeline — scheduled content generation agent.
 *
 * Cron: daily at 6am UTC. Picks a topic from the configured list,
 * generates content via Workers AI, and stores it in R2.
 *
 * API:
 *   POST /topics          — add a topic
 *   GET  /topics          — list all topics
 *   GET  /content         — list generated content (newest first)
 *   GET  /content/:id     — get a single generated piece
 *   GET  /config          — view current config
 *   PUT  /config          — update config
 */

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

// ── Types ─────────────────────────────────────────────────────

export type ContentType = "blog" | "social" | "newsletter";
export type Tone =
	| "professional"
	| "casual"
	| "witty"
	| "inspirational"
	| "educational";
export type Length = "short" | "medium" | "long";

interface Config {
	contentType: ContentType;
	tone: Tone;
	length: Length;
	targetAudience: string;
	model: string;
}

interface Topic {
	id: string;
	text: string;
	addedAt: string;
	usedAt?: string;
}

interface GeneratedContent {
	id: string;
	topicId: string;
	topic: string;
	contentType: ContentType;
	body: string;
	generatedAt: string;
	config: Config;
}

interface Env {
	AI: Ai;
	CONTENT: R2Bucket;
	PIPELINE: DurableObjectNamespace;
}

// ── Word counts by length ──────────────────────────────────────

const LENGTH_GUIDE: Record<Length, string> = {
	short: "around 150 words",
	medium: "around 400 words",
	long: "around 800 words",
};

const CONTENT_TYPE_INSTRUCTIONS: Record<ContentType, string> = {
	blog: "Write a blog post with a compelling title, an engaging introduction, 2-3 body sections with subheadings, and a brief conclusion.",
	social:
		"Write a social media post suitable for LinkedIn and Twitter/X. Keep it punchy, include relevant hashtags at the end.",
	newsletter:
		"Write a newsletter section with a subject line, a warm greeting, the main content, and a call-to-action sign-off.",
};

// ── Prompt builder ─────────────────────────────────────────────

function buildPrompt(topic: string, config: Config): string {
	return `You are a ${config.tone} content writer targeting ${config.targetAudience}.

${CONTENT_TYPE_INSTRUCTIONS[config.contentType]}

Topic: ${topic}
Length: ${LENGTH_GUIDE[config.length]}
Tone: ${config.tone}

Write only the content itself — no meta-commentary, no "here is your post" preamble.`;
}

// ── Hono API ───────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

// Health check
app.get("/", (c) =>
	c.json({ agent: "content-pipeline", type: "cron+api", status: "ok" }),
);

// ── /topics ────────────────────────────────────────────────────

app.post("/topics", async (c) => {
	const body = await c.req.json<{ text: string }>().catch(() => null);
	if (!body?.text?.trim()) return c.json({ error: "text required" }, 400);

	const stub = getPipelineStub(c.env);
	const res = await stub.fetch(
		new Request("http://do/topics", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: body.text.trim() }),
		}),
	);
	return new Response(res.body, { status: res.status, headers: res.headers });
});

app.get("/topics", async (c) => {
	const stub = getPipelineStub(c.env);
	const res = await stub.fetch(new Request("http://do/topics"));
	return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── /content ───────────────────────────────────────────────────

app.get("/content", async (c) => {
	const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
	const cursor = c.req.query("cursor");

	const listed = await c.env.CONTENT.list({
		prefix: "content/",
		limit,
		cursor: cursor ?? undefined,
	});

	// R2 list returns keys sorted lexicographically; keys include timestamp so newest-first
	// requires reverse sort (we store keys as content/<iso-timestamp>-<id>)
	const keys = listed.objects
		.map((o) => o.key)
		.sort()
		.reverse();

	const items = await Promise.all(
		keys.map(async (key) => {
			const obj = await c.env.CONTENT.get(key);
			if (!obj) return null;
			return obj.json<GeneratedContent>();
		}),
	);

	return c.json({
		items: items.filter(Boolean),
		truncated: listed.truncated,
		cursor: listed.truncated ? listed.cursor : undefined,
	});
});

app.get("/content/:id", async (c) => {
	const id = c.req.param("id");
	// Search by id suffix — scan index stored in DO
	const stub = getPipelineStub(c.env);
	const res = await stub.fetch(new Request(`http://do/content-key/${id}`));
	if (res.status === 404) return c.json({ error: "not found" }, 404);

	const { key } = await res.json<{ key: string }>();
	const obj = await c.env.CONTENT.get(key);
	if (!obj) return c.json({ error: "not found" }, 404);

	const content = await obj.json<GeneratedContent>();
	return c.json(content);
});

// ── /config ────────────────────────────────────────────────────

app.get("/config", async (c) => {
	const stub = getPipelineStub(c.env);
	const res = await stub.fetch(new Request("http://do/config"));
	return new Response(res.body, { status: res.status, headers: res.headers });
});

app.put("/config", async (c) => {
	const body = await c.req.json<Partial<Config>>().catch(() => null);
	if (!body) return c.json({ error: "invalid JSON body" }, 400);

	const stub = getPipelineStub(c.env);
	const res = await stub.fetch(
		new Request("http://do/config", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
	return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Cron export ────────────────────────────────────────────────

export default {
	fetch: app.fetch,

	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(runPipeline(env));
	},
};

async function runPipeline(env: Env) {
	const stub = getPipelineStub(env);

	// Pick the next topic (round-robin, oldest-used first)
	const topicRes = await stub.fetch(
		new Request("http://do/next-topic", { method: "POST" }),
	);
	if (topicRes.status === 204) {
		console.log("[content-pipeline] No topics configured — skipping cron run.");
		return;
	}
	const { topic } = await topicRes.json<{ topic: Topic }>();

	// Get current config
	const configRes = await stub.fetch(new Request("http://do/config"));
	const config = await configRes.json<Config>();

	// Generate content
	const prompt = buildPrompt(topic.text, config);
	const aiResult = (await env.AI.run(config.model as Parameters<Ai["run"]>[0], {
		messages: [
			{
				role: "system",
				content:
					"You are an expert content writer. Follow all instructions precisely.",
			},
			{ role: "user", content: prompt },
		],
	})) as { response?: string };

	const body = aiResult.response?.trim() ?? "";
	if (!body) {
		console.error("[content-pipeline] Empty AI response — skipping storage.");
		return;
	}

	const id = crypto.randomUUID();
	const generatedAt = new Date().toISOString();
	const content: GeneratedContent = {
		id,
		topicId: topic.id,
		topic: topic.text,
		contentType: config.contentType,
		body,
		generatedAt,
		config,
	};

	// Store in R2 — key includes timestamp for lexicographic ordering
	const r2Key = `content/${generatedAt}-${id}`;
	await env.CONTENT.put(r2Key, JSON.stringify(content), {
		httpMetadata: { contentType: "application/json" },
	});

	// Record the key in DO index so /content/:id lookups work
	await stub.fetch(
		new Request("http://do/index-content", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id, key: r2Key }),
		}),
	);

	console.log(
		`[content-pipeline] Generated ${config.contentType} for topic "${topic.text}" → ${r2Key}`,
	);
}

// ── Helper ─────────────────────────────────────────────────────

function getPipelineStub(env: Env) {
	const doId = env.PIPELINE.idFromName("main");
	return env.PIPELINE.get(doId);
}

// ── Durable Object ─────────────────────────────────────────────

const DEFAULT_CONFIG: Config = {
	contentType: "blog",
	tone: "professional",
	length: "medium",
	targetAudience: "general audience",
	model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
};

export class PipelineDO extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const method = request.method;

		// ── POST /topics ──────────────────────────────────────────
		if (url.pathname === "/topics" && method === "POST") {
			const { text } = await request.json<{ text: string }>();
			const id = crypto.randomUUID();
			const topic: Topic = { id, text, addedAt: new Date().toISOString() };
			await this.ctx.storage.put(`topic:${id}`, topic);
			return json(topic, 201);
		}

		// ── GET /topics ───────────────────────────────────────────
		if (url.pathname === "/topics" && method === "GET") {
			const entries = await this.ctx.storage.list<Topic>({ prefix: "topic:" });
			const topics = [...entries.values()].sort((a, b) =>
				a.addedAt.localeCompare(b.addedAt),
			);
			return json(topics);
		}

		// ── POST /next-topic (internal — cron use only) ───────────
		if (url.pathname === "/next-topic" && method === "POST") {
			const entries = await this.ctx.storage.list<Topic>({ prefix: "topic:" });
			const topics = [...entries.values()];
			if (topics.length === 0) return new Response(null, { status: 204 });

			// Pick the topic least-recently used (no usedAt = highest priority)
			topics.sort((a, b) => {
				if (!a.usedAt && !b.usedAt) return a.addedAt.localeCompare(b.addedAt);
				if (!a.usedAt) return -1;
				if (!b.usedAt) return 1;
				return a.usedAt.localeCompare(b.usedAt);
			});

			const topic = topics[0];
			topic.usedAt = new Date().toISOString();
			await this.ctx.storage.put(`topic:${topic.id}`, topic);

			return json({ topic });
		}

		// ── GET /content-key/:id (internal — API lookup) ──────────
		if (url.pathname.startsWith("/content-key/") && method === "GET") {
			const id = url.pathname.slice("/content-key/".length);
			const key = await this.ctx.storage.get<string>(`content-index:${id}`);
			if (!key) return new Response(null, { status: 404 });
			return json({ key });
		}

		// ── POST /index-content (internal — cron use only) ────────
		if (url.pathname === "/index-content" && method === "POST") {
			const { id, key } = await request.json<{ id: string; key: string }>();
			await this.ctx.storage.put(`content-index:${id}`, key);
			return json({ ok: true });
		}

		// ── GET /config ───────────────────────────────────────────
		if (url.pathname === "/config" && method === "GET") {
			const stored = await this.ctx.storage.get<Config>("config");
			return json(stored ?? DEFAULT_CONFIG);
		}

		// ── PUT /config ───────────────────────────────────────────
		if (url.pathname === "/config" && method === "PUT") {
			const patch = await request.json<Partial<Config>>();
			const current = (await this.ctx.storage.get<Config>("config")) ?? {
				...DEFAULT_CONFIG,
			};

			const VALID_CONTENT_TYPES: ContentType[] = [
				"blog",
				"social",
				"newsletter",
			];
			const VALID_TONES: Tone[] = [
				"professional",
				"casual",
				"witty",
				"inspirational",
				"educational",
			];
			const VALID_LENGTHS: Length[] = ["short", "medium", "long"];

			if (
				patch.contentType !== undefined &&
				!VALID_CONTENT_TYPES.includes(patch.contentType)
			) {
				return json(
					{
						error: `contentType must be one of: ${VALID_CONTENT_TYPES.join(", ")}`,
					},
					400,
				);
			}
			if (patch.tone !== undefined && !VALID_TONES.includes(patch.tone)) {
				return json(
					{ error: `tone must be one of: ${VALID_TONES.join(", ")}` },
					400,
				);
			}
			if (patch.length !== undefined && !VALID_LENGTHS.includes(patch.length)) {
				return json(
					{ error: `length must be one of: ${VALID_LENGTHS.join(", ")}` },
					400,
				);
			}

			const updated: Config = {
				contentType: patch.contentType ?? current.contentType,
				tone: patch.tone ?? current.tone,
				length: patch.length ?? current.length,
				targetAudience: patch.targetAudience?.trim() ?? current.targetAudience,
				model: patch.model?.trim() ?? current.model,
			};

			await this.ctx.storage.put("config", updated);
			return json(updated);
		}

		return new Response("Not found", { status: 404 });
	}
}

// ── Mini helper ────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
