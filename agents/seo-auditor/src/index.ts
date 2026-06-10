/**
 * seo-auditor — a ProAgentStore daily SEO audit agent.
 *
 * Cron fires at 05:00 UTC. For each configured site it:
 *   1. Fetches the page HTML
 *   2. Extracts: title, meta description, h1-h6 structure, image alt tags,
 *      internal/external links, word count, JSON-LD schema markup
 *   3. Calls Workers AI to score the page 0-100 and generate recommendations
 *   4. Persists the audit row to D1
 *   5. Compares to the previous score and flags regressions
 *   6. Stores a rolling score history in AuditStateDO
 *
 * API:
 *   POST /sites               — add a URL to audit
 *   GET  /sites               — list all configured sites
 *   GET  /audits              — list all audits (latest first, paginated)
 *   GET  /audits/latest       — latest audit per site
 *   GET  /audits/:id          — single audit by id
 *   POST /cron/trigger        — manually run a full audit cycle (dev/debug)
 *   GET  /health              — liveness probe
 */

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

// ── Types ──────────────────────────────────────────────────────────────────

export interface Env {
	AI: Ai;
	DB: D1Database;
	AUDIT_STATE: DurableObjectNamespace;
	ADMIN_TOKEN?: string;
}

interface Site {
	id: string;
	url: string;
	label: string;
	enabled: number;
	created_at: string;
}

interface AuditRow {
	id: string;
	site_id: string;
	audited_at: string;
	score: number;
	title: string;
	meta_desc: string;
	word_count: number;
	h1_count: number;
	images_total: number;
	images_no_alt: number;
	links_internal: number;
	links_external: number;
	has_schema: number;
	recommendations: string; // JSON array of strings
	regression: number;
}

interface ExtractedData {
	title: string;
	metaDesc: string;
	headings: { level: number; text: string }[];
	h1Count: number;
	wordCount: number;
	imagesTotal: number;
	imagesNoAlt: number;
	linksInternal: number;
	linksExternal: number;
	hasSchema: boolean;
}

interface ScoreResult {
	score: number;
	recommendations: string[];
}

// ── Utility ────────────────────────────────────────────────────────────────

function nanoid(len = 12): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let id = "";
	const bytes = crypto.getRandomValues(new Uint8Array(len));
	for (const b of bytes) id += chars[b % chars.length];
	return id;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

// ── HTML extraction ────────────────────────────────────────────────────────

/**
 * Extract SEO signals from raw HTML without a DOM parser.
 * Uses regex — sufficient for structured metadata extraction.
 */
function extractSeoData(html: string, baseUrl: string): ExtractedData {
	// Title
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleMatch ? stripTags(titleMatch[1]).trim() : "";

	// Meta description
	const metaMatch = html.match(
		/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
	) ?? html.match(
		/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i,
	);
	const metaDesc = metaMatch ? metaMatch[1].trim() : "";

	// Headings h1-h6
	const headingPattern = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
	const headings: { level: number; text: string }[] = [];
	for (const hMatch of html.matchAll(headingPattern)) {
		headings.push({ level: parseInt(hMatch[1], 10), text: stripTags(hMatch[2]).trim() });
	}
	const h1Count = headings.filter((h) => h.level === 1).length;

	// Word count — strip scripts/styles then all tags
	const bodyText = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const wordCount = bodyText ? bodyText.split(" ").filter(Boolean).length : 0;

	// Images — total and missing alt
	const imgPattern = /<img([^>]*)>/gi;
	let imagesTotal = 0;
	let imagesNoAlt = 0;
	for (const imgMatch of html.matchAll(imgPattern)) {
		imagesTotal++;
		const attrs = imgMatch[1];
		const hasAlt = /alt=["'][^"']*["']/i.test(attrs) && !/alt=["']["']/i.test(attrs);
		if (!hasAlt) imagesNoAlt++;
	}

	// Links — internal vs external
	const parsed = new URL(baseUrl);
	const linkPattern = /<a[^>]+href=["']([^"'#][^"']*)["']/gi;
	let linksInternal = 0;
	let linksExternal = 0;
	for (const linkMatch of html.matchAll(linkPattern)) {
		const href = linkMatch[1].trim();
		if (href.startsWith("mailto:") || href.startsWith("tel:")) continue;
		try {
			const target = new URL(href, baseUrl);
			if (target.hostname === parsed.hostname) {
				linksInternal++;
			} else {
				linksExternal++;
			}
		} catch {
			// relative or malformed — count as internal
			linksInternal++;
		}
	}

	// JSON-LD schema markup
	const hasSchema = /<script[^>]+type=["']application\/ld\+json["']/i.test(html);

	return {
		title,
		metaDesc,
		headings,
		h1Count,
		wordCount,
		imagesTotal,
		imagesNoAlt,
		linksInternal,
		linksExternal,
		hasSchema,
	};
}

function stripTags(s: string): string {
	return s.replace(/<[^>]+>/g, "");
}

// ── Workers AI scoring ─────────────────────────────────────────────────────

async function scorePage(
	ai: Ai,
	url: string,
	data: ExtractedData,
): Promise<ScoreResult> {
	const summary = [
		`URL: ${url}`,
		`Title: "${data.title}" (${data.title.length} chars)`,
		`Meta description: "${data.metaDesc}" (${data.metaDesc.length} chars)`,
		`H1 count: ${data.h1Count}`,
		`Headings: ${data.headings.map((h) => `H${h.level}:"${h.text.slice(0, 60)}"`).slice(0, 10).join(", ")}`,
		`Word count: ${data.wordCount}`,
		`Images: ${data.imagesTotal} total, ${data.imagesNoAlt} missing alt text`,
		`Links: ${data.linksInternal} internal, ${data.linksExternal} external`,
		`JSON-LD schema: ${data.hasSchema ? "present" : "absent"}`,
	].join("\n");

	const result = (await ai.run(
		"@cf/meta/llama-3.3-70b-instruct-fp8-fast" as Parameters<Ai["run"]>[0],
		{
			messages: [
				{
					role: "system",
					content: `You are an SEO expert. Given SEO signals extracted from a webpage, score it from 0 to 100 and list 3-6 specific, actionable recommendations.

Scoring criteria:
- Title: present (10pts), 50-60 chars (10pts)
- Meta description: present (10pts), 120-160 chars (10pts)
- H1: exactly one (15pts)
- Word count: 300+ words (10pts), 600+ (5pts bonus)
- Images: all have alt text (10pts), deduct 2pts per missing alt up to 10pts
- Schema markup: present (10pts)
- Links: has both internal and external links (10pts)

Respond with valid JSON only, no markdown, no explanation outside JSON:
{"score": <number>, "recommendations": ["<string>", ...]}`,
				},
				{
					role: "user",
					content: summary,
				},
			],
		},
	)) as { response?: string };

	const raw = result.response?.trim() ?? "";

	// Parse JSON from AI response — extract first JSON object found
	const jsonMatch = raw.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]) as { score?: number; recommendations?: string[] };
			const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score ?? 0))));
			const recommendations = Array.isArray(parsed.recommendations)
				? parsed.recommendations.filter((r) => typeof r === "string").slice(0, 10)
				: [];
			return { score, recommendations };
		} catch {
			// fall through to rule-based fallback
		}
	}

	// Rule-based fallback if AI response is unparseable
	return ruleBasedScore(data);
}

/** Deterministic fallback scoring when AI is unavailable or response is malformed. */
function ruleBasedScore(data: ExtractedData): ScoreResult {
	let score = 0;
	const recommendations: string[] = [];

	// Title
	if (data.title) {
		score += 10;
		if (data.title.length >= 50 && data.title.length <= 60) {
			score += 10;
		} else {
			recommendations.push(
				`Adjust title length to 50-60 characters (currently ${data.title.length}).`,
			);
		}
	} else {
		recommendations.push("Add a <title> tag — it is missing.");
	}

	// Meta description
	if (data.metaDesc) {
		score += 10;
		if (data.metaDesc.length >= 120 && data.metaDesc.length <= 160) {
			score += 10;
		} else {
			recommendations.push(
				`Adjust meta description length to 120-160 characters (currently ${data.metaDesc.length}).`,
			);
		}
	} else {
		recommendations.push("Add a meta description tag — it is missing.");
	}

	// H1
	if (data.h1Count === 1) {
		score += 15;
	} else if (data.h1Count === 0) {
		recommendations.push("Add exactly one H1 heading to the page.");
	} else {
		recommendations.push(`Reduce H1 count to exactly one (currently ${data.h1Count}).`);
	}

	// Word count
	if (data.wordCount >= 600) {
		score += 15;
	} else if (data.wordCount >= 300) {
		score += 10;
		recommendations.push("Expand content beyond 600 words for stronger SEO signals.");
	} else {
		recommendations.push(`Page has only ${data.wordCount} words — aim for 300+ minimum.`);
	}

	// Images
	const altPenalty = Math.min(10, data.imagesNoAlt * 2);
	score += Math.max(0, 10 - altPenalty);
	if (data.imagesNoAlt > 0) {
		recommendations.push(
			`Add alt text to ${data.imagesNoAlt} image(s) that are currently missing it.`,
		);
	}

	// Schema
	if (data.hasSchema) {
		score += 10;
	} else {
		recommendations.push("Add JSON-LD schema markup (e.g. Organization, WebPage) to improve rich results.");
	}

	// Links
	if (data.linksInternal > 0 && data.linksExternal > 0) {
		score += 10;
	} else if (data.linksInternal === 0) {
		recommendations.push("Add internal links to help search engines discover other pages.");
	} else if (data.linksExternal === 0) {
		recommendations.push("Add at least one external link to a credible source.");
	}

	return { score: Math.min(100, score), recommendations };
}

// ── Cron logic ─────────────────────────────────────────────────────────────

async function runCron(env: Env): Promise<{ audited: number; regressions: number; errors: number }> {
	const { results: sites } = await env.DB.prepare(
		"SELECT * FROM sites WHERE enabled = 1",
	).all<Site>();

	let regressions = 0;
	let errors = 0;

	for (const site of sites) {
		try {
			await auditSite(site, env);
			const latest = await env.DB.prepare(
				"SELECT regression FROM audits WHERE site_id = ? ORDER BY audited_at DESC LIMIT 1",
			).bind(site.id).first<{ regression: number }>();
			if (latest?.regression) regressions++;
		} catch (err) {
			errors++;
			console.error(`[seo-auditor] Error auditing ${site.url}:`, err);
		}
	}

	return { audited: sites.length, regressions, errors };
}

async function auditSite(site: Site, env: Env): Promise<AuditRow> {
	// Fetch page
	const res = await fetch(site.url, {
		headers: { "User-Agent": "SEOAuditBot/1.0 (ProAgentStore)" },
		redirect: "follow",
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${site.url}`);
	const html = await res.text();

	// Extract signals
	const data = extractSeoData(html, site.url);

	// AI scoring
	const { score, recommendations } = await scorePage(env.AI, site.url, data);

	// Check for regression vs previous audit
	const prev = await env.DB.prepare(
		"SELECT score FROM audits WHERE site_id = ? ORDER BY audited_at DESC LIMIT 1",
	).bind(site.id).first<{ score: number }>();
	const regression = prev !== null && score < prev.score ? 1 : 0;

	// Persist audit
	const id = nanoid();
	await env.DB.prepare(`
		INSERT INTO audits(
			id, site_id, score, title, meta_desc, word_count,
			h1_count, images_total, images_no_alt,
			links_internal, links_external, has_schema,
			recommendations, regression
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		id,
		site.id,
		score,
		data.title,
		data.metaDesc,
		data.wordCount,
		data.h1Count,
		data.imagesTotal,
		data.imagesNoAlt,
		data.linksInternal,
		data.linksExternal,
		data.hasSchema ? 1 : 0,
		JSON.stringify(recommendations),
		regression,
	).run();

	// Persist score history to DO (keeps latest 90 entries per site)
	const doId = env.AUDIT_STATE.idFromName(site.id);
	const stub = env.AUDIT_STATE.get(doId);
	await stub.fetch(new Request("http://do/record", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ auditId: id, score, audited_at: new Date().toISOString(), regression }),
	}));

	const row: AuditRow = {
		id, site_id: site.id, audited_at: new Date().toISOString(),
		score, title: data.title, meta_desc: data.metaDesc,
		word_count: data.wordCount, h1_count: data.h1Count,
		images_total: data.imagesTotal, images_no_alt: data.imagesNoAlt,
		links_internal: data.linksInternal, links_external: data.linksExternal,
		has_schema: data.hasSchema ? 1 : 0,
		recommendations: JSON.stringify(recommendations),
		regression,
	};

	if (regression) {
		console.warn(
			`[seo-auditor] REGRESSION site=${site.id} url=${site.url} prev=${prev?.score} now=${score}`,
		);
	} else {
		console.log(`[seo-auditor] audited site=${site.id} score=${score}`);
	}

	return row;
}

// ── Durable Object — per-site score history ────────────────────────────────

interface ScoreEntry {
	auditId: string;
	score: number;
	audited_at: string;
	regression: number;
}

export class AuditStateDO extends DurableObject<Env> {
	/**
	 * Internal routing:
	 *   POST /record   — append a score entry (keeps latest 90)
	 *   GET  /history  — return score history array
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/record" && request.method === "POST") {
			const entry = await request.json<ScoreEntry>();
			const history = (await this.ctx.storage.get<ScoreEntry[]>("history")) ?? [];
			history.push(entry);
			// Retain latest 90 data points
			const trimmed = history.slice(-90);
			await this.ctx.storage.put("history", trimmed);
			return json({ ok: true });
		}

		if (url.pathname === "/history" && request.method === "GET") {
			const history = (await this.ctx.storage.get<ScoreEntry[]>("history")) ?? [];
			return json({ history });
		}

		return new Response("Not found", { status: 404 });
	}
}

// ── Hono API ───────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ agent: "seo-auditor", status: "ok" }));

// POST /sites — register a URL for daily auditing
app.post("/sites", async (c) => {
	const body = await c.req.json<{ url: string; label?: string }>();
	if (!body.url) return c.json({ error: "url is required" }, 400);

	let parsed: URL;
	try {
		parsed = new URL(body.url);
	} catch {
		return c.json({ error: "invalid url" }, 400);
	}
	if (!["http:", "https:"].includes(parsed.protocol)) {
		return c.json({ error: "url must be http or https" }, 400);
	}

	const existing = await c.env.DB.prepare("SELECT id FROM sites WHERE url = ?")
		.bind(body.url).first<{ id: string }>();
	if (existing) return c.json({ error: "url already registered", id: existing.id }, 409);

	const id = nanoid();
	await c.env.DB.prepare(
		"INSERT INTO sites(id, url, label) VALUES (?, ?, ?)",
	).bind(id, body.url, body.label ?? parsed.hostname).run();

	return c.json({ id, url: body.url, label: body.label ?? parsed.hostname }, 201);
});

// GET /sites — list all registered sites
app.get("/sites", async (c) => {
	const { results } = await c.env.DB.prepare(
		"SELECT * FROM sites ORDER BY created_at DESC",
	).all<Site>();
	return c.json({ sites: results });
});

// GET /audits — paginated audit list (latest first)
app.get("/audits", async (c) => {
	const limit = Math.min(Number(c.req.query("limit") ?? "20"), 100);
	const offset = Number(c.req.query("offset") ?? "0");
	const siteId = c.req.query("site_id");

	let stmt: D1PreparedStatement;
	if (siteId) {
		stmt = c.env.DB.prepare(
			"SELECT * FROM audits WHERE site_id = ? ORDER BY audited_at DESC LIMIT ? OFFSET ?",
		).bind(siteId, limit, offset);
	} else {
		stmt = c.env.DB.prepare(
			"SELECT * FROM audits ORDER BY audited_at DESC LIMIT ? OFFSET ?",
		).bind(limit, offset);
	}

	const { results } = await stmt.all<AuditRow>();
	const parsed = results.map(deserializeAudit);

	return c.json({ audits: parsed, limit, offset });
});

// GET /audits/latest — latest audit per site
app.get("/audits/latest", async (c) => {
	const { results: sites } = await c.env.DB.prepare(
		"SELECT id, url, label FROM sites WHERE enabled = 1 ORDER BY created_at DESC",
	).all<Pick<Site, "id" | "url" | "label">>();

	const latest = await Promise.all(
		sites.map(async (site) => {
			const row = await c.env.DB.prepare(
				"SELECT * FROM audits WHERE site_id = ? ORDER BY audited_at DESC LIMIT 1",
			).bind(site.id).first<AuditRow>();
			return row ? { site, audit: deserializeAudit(row) } : { site, audit: null };
		}),
	);

	return c.json({ latest });
});

// GET /audits/:id — single audit
app.get("/audits/:id", async (c) => {
	const { id } = c.req.param();
	const row = await c.env.DB.prepare("SELECT * FROM audits WHERE id = ?")
		.bind(id).first<AuditRow>();
	if (!row) return c.json({ error: "not found" }, 404);
	return c.json(deserializeAudit(row));
});

// POST /cron/trigger — manually run the full audit cycle
app.post("/cron/trigger", async (c) => {
	const result = await runCron(c.env);
	return c.json({ ok: true, ...result });
});

// Deserialize DB row — parse recommendations JSON and cast has_schema/regression to bool
function deserializeAudit(row: AuditRow) {
	let recommendations: string[] = [];
	try {
		recommendations = JSON.parse(row.recommendations) as string[];
	} catch {
		recommendations = [];
	}
	return {
		...row,
		recommendations,
		has_schema: row.has_schema === 1,
		regression: row.regression === 1,
	};
}

// ── Worker export ──────────────────────────────────────────────────────────

export default {
	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		console.log(`[seo-auditor] cron fired at ${new Date().toISOString()}`);
		ctx.waitUntil(
			runCron(env).then(({ audited, regressions, errors }) => {
				console.log(
					`[seo-auditor] done — audited=${audited} regressions=${regressions} errors=${errors}`,
				);
			}),
		);
	},

	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return app.fetch(request, env, ctx);
	},
};
