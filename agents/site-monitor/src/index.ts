/**
 * site-monitor — a ProAgentStore scheduled agent.
 *
 * Runs hourly. For each configured URL it:
 *   1. Fetches the page content
 *   2. Hashes it and compares to the last-known hash (stored in the SiteStateDO)
 *   3. On change: writes a history row to D1 and fires a webhook
 *
 * API (all routes under /):
 *   POST   /sites              — add a URL to monitor
 *   DELETE /sites/:id          — remove a URL
 *   GET    /sites              — list all monitored URLs with current state
 *   GET    /sites/:id/history  — paginated change history for one site
 *   GET    /config             — get global webhook URL
 *   PUT    /config             — set global webhook URL
 *   POST   /cron/trigger       — manually trigger one cron cycle (dev/debug)
 *   GET    /health             — liveness probe
 */

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

// ── Types ─────────────────────────────────────────────────────────────────

export interface Env {
	DB: D1Database;
	SITE_STATE: DurableObjectNamespace;
	WEBHOOK_SECRET?: string;
}

interface Site {
	id: string;
	url: string;
	label: string;
	webhook_url: string | null;
	enabled: number;
	created_at: string;
}

interface ChangeHistory {
	id: string;
	site_id: string;
	detected_at: string;
	old_hash: string;
	new_hash: string;
	summary: string;
	content_len: number;
}

interface SiteStateData {
	url: string;
	hash: string;
	last_checked: string;
	last_changed: string | null;
	consecutive_errors: number;
}

// ── Utility ───────────────────────────────────────────────────────────────

function nanoid(len = 12): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let id = "";
	const bytes = crypto.getRandomValues(new Uint8Array(len));
	for (const b of bytes) id += chars[b % chars.length];
	return id;
}

async function sha256hex(text: string): Promise<string> {
	const buf = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** Strip HTML tags, collapse whitespace — produces a stable text fingerprint. */
function normalizeContent(raw: string): string {
	return raw
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Build a short diff summary (first changed line context). */
function diffSummary(oldText: string, newText: string): string {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const added: string[] = [];
	const removed: string[] = [];

	const oldSet = new Set(oldLines);
	const newSet = new Set(newLines);

	for (const l of newLines)
		if (!oldSet.has(l) && l.trim()) added.push(l.trim());
	for (const l of oldLines)
		if (!newSet.has(l) && l.trim()) removed.push(l.trim());

	const parts: string[] = [];
	if (removed.length)
		parts.push(`Removed: "${removed.slice(0, 2).join(" | ").slice(0, 120)}"`);
	if (added.length)
		parts.push(`Added: "${added.slice(0, 2).join(" | ").slice(0, 120)}"`);
	return parts.join(" | ") || "Content changed";
}

async function fireWebhook(
	webhookUrl: string,
	payload: Record<string, unknown>,
	secret?: string,
): Promise<void> {
	const body = JSON.stringify(payload);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};

	if (secret) {
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const sig = await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(body),
		);
		headers["X-Hub-Signature-256"] =
			"sha256=" +
			Array.from(new Uint8Array(sig))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
	}

	await fetch(webhookUrl, { method: "POST", headers, body });
}

// ── Durable Object — per-site state ──────────────────────────────────────

export class SiteStateDO extends DurableObject<Env> {
	/**
	 * Internal routing (all via Worker → DO fetch):
	 *   GET  /state        — return current SiteStateData
	 *   POST /check        — fetch URL, compare hash, return { changed, oldHash, newHash, summary, contentLen }
	 *   POST /reset        — clear stored state (used when a site is re-added)
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/state" && request.method === "GET") {
			const state = await this.ctx.storage.get<SiteStateData>("state");
			if (!state)
				return new Response(JSON.stringify(null), {
					headers: { "Content-Type": "application/json" },
				});
			return new Response(JSON.stringify(state), {
				headers: { "Content-Type": "application/json" },
			});
		}

		if (url.pathname === "/check" && request.method === "POST") {
			const { siteUrl } = await request.json<{ siteUrl: string }>();

			let fetchedText = "";
			try {
				const res = await fetch(siteUrl, {
					headers: { "User-Agent": "site-monitor/1.0 (ProAgentStore)" },
					redirect: "follow",
					signal: AbortSignal.timeout(15_000),
				});
				fetchedText = await res.text();
			} catch (err) {
				const state = await this.ctx.storage.get<SiteStateData>("state");
				const errors = (state?.consecutive_errors ?? 0) + 1;
				await this.ctx.storage.put<SiteStateData>("state", {
					url: siteUrl,
					hash: state?.hash ?? "",
					last_checked: new Date().toISOString(),
					last_changed: state?.last_changed ?? null,
					consecutive_errors: errors,
				});
				return new Response(
					JSON.stringify({
						changed: false,
						error: String(err),
						consecutive_errors: errors,
					}),
					{
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			const normalized = normalizeContent(fetchedText);
			const newHash = await sha256hex(normalized);
			// Load previous state and stored text in parallel
			const [prevState, prevText] = await Promise.all([
				this.ctx.storage.get<SiteStateData>("state"),
				this.ctx.storage.get<string>("normalized"),
			]);
			const oldHash = prevState?.hash ?? "";
			const changed = oldHash !== "" && oldHash !== newHash;
			const summary = changed
				? diffSummary(prevText ?? "", normalized.slice(0, 4000))
				: "";

			await this.ctx.storage.put<SiteStateData>("state", {
				url: siteUrl,
				hash: newHash,
				last_checked: new Date().toISOString(),
				last_changed: changed
					? new Date().toISOString()
					: (prevState?.last_changed ?? null),
				consecutive_errors: 0,
			});
			await this.ctx.storage.put<string>(
				"normalized",
				normalized.slice(0, 4000),
			);

			return new Response(
				JSON.stringify({
					changed,
					oldHash,
					newHash,
					summary,
					contentLen: fetchedText.length,
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
		}

		if (url.pathname === "/reset" && request.method === "POST") {
			await this.ctx.storage.deleteAll();
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		return new Response("Not found", { status: 404 });
	}
}

// ── Cron logic ────────────────────────────────────────────────────────────

async function runCron(
	env: Env,
): Promise<{ checked: number; changed: number; errors: number }> {
	const sites = await env.DB.prepare(
		"SELECT * FROM sites WHERE enabled = 1",
	).all<Site>();

	const globalWebhookRow = await env.DB.prepare(
		"SELECT value FROM config WHERE key = ?",
	)
		.bind("webhook_url")
		.first<{ value: string }>();
	const globalWebhookUrl = globalWebhookRow?.value ?? "";

	let changed = 0;
	let errors = 0;

	for (const site of sites.results) {
		const doId = env.SITE_STATE.idFromName(site.id);
		const stub = env.SITE_STATE.get(doId);

		const res = await stub.fetch(
			new Request("http://do/check", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ siteUrl: site.url }),
			}),
		);

		const result = await res.json<{
			changed: boolean;
			error?: string;
			oldHash: string;
			newHash: string;
			summary: string;
			contentLen: number;
			consecutive_errors?: number;
		}>();

		if (result.error) {
			errors++;
			console.error(
				`[site-monitor] Error checking ${site.url}: ${result.error}`,
			);
			continue;
		}

		if (result.changed) {
			changed++;
			const historyId = nanoid();
			await env.DB.prepare(
				`INSERT INTO change_history(id, site_id, old_hash, new_hash, summary, content_len)
         VALUES (?, ?, ?, ?, ?, ?)`,
			)
				.bind(
					historyId,
					site.id,
					result.oldHash,
					result.newHash,
					result.summary,
					result.contentLen,
				)
				.run();

			const webhookUrl = site.webhook_url || globalWebhookUrl;
			if (webhookUrl) {
				const payload = {
					event: "site.changed",
					site: { id: site.id, url: site.url, label: site.label },
					change: {
						id: historyId,
						detected_at: new Date().toISOString(),
						old_hash: result.oldHash,
						new_hash: result.newHash,
						summary: result.summary,
						content_len: result.contentLen,
					},
				};
				try {
					await fireWebhook(webhookUrl, payload, env.WEBHOOK_SECRET);
				} catch (err) {
					console.error(
						`[site-monitor] Webhook delivery failed for ${site.url}: ${err}`,
					);
				}
			}
		}
	}

	return { checked: sites.results.length, changed, errors };
}

// ── Hono API ──────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ agent: "site-monitor", status: "ok" }));

// POST /sites — add a URL to monitor
app.post("/sites", async (c) => {
	const body = await c.req.json<{
		url: string;
		label?: string;
		webhook_url?: string;
	}>();
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

	// Deduplicate by URL
	const existing = await c.env.DB.prepare("SELECT id FROM sites WHERE url = ?")
		.bind(body.url)
		.first<{ id: string }>();
	if (existing)
		return c.json({ error: "url already monitored", id: existing.id }, 409);

	const id = nanoid();
	await c.env.DB.prepare(
		"INSERT INTO sites(id, url, label, webhook_url) VALUES (?, ?, ?, ?)",
	)
		.bind(id, body.url, body.label ?? "", body.webhook_url ?? null)
		.run();

	return c.json(
		{
			id,
			url: body.url,
			label: body.label ?? "",
			webhook_url: body.webhook_url ?? null,
		},
		201,
	);
});

// DELETE /sites/:id — remove a URL
app.delete("/sites/:id", async (c) => {
	const { id } = c.req.param();
	const site = await c.env.DB.prepare("SELECT id FROM sites WHERE id = ?")
		.bind(id)
		.first<{ id: string }>();
	if (!site) return c.json({ error: "not found" }, 404);

	await c.env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(id).run();

	// Clear DO state so if re-added it starts fresh
	const doId = c.env.SITE_STATE.idFromName(id);
	const stub = c.env.SITE_STATE.get(doId);
	await stub.fetch(new Request("http://do/reset", { method: "POST" }));

	return c.json({ ok: true });
});

// GET /sites — list all sites with current DO state
app.get("/sites", async (c) => {
	const { results } = await c.env.DB.prepare(
		"SELECT * FROM sites ORDER BY created_at DESC",
	).all<Site>();

	// Fetch live state from each DO in parallel
	const withState = await Promise.all(
		results.map(async (site) => {
			const doId = c.env.SITE_STATE.idFromName(site.id);
			const stub = c.env.SITE_STATE.get(doId);
			const res = await stub.fetch(new Request("http://do/state"));
			const state = await res.json<SiteStateData | null>();
			return { ...site, state };
		}),
	);

	return c.json({ sites: withState });
});

// GET /sites/:id/history — paginated change history
app.get("/sites/:id/history", async (c) => {
	const { id } = c.req.param();
	const site = await c.env.DB.prepare("SELECT id FROM sites WHERE id = ?")
		.bind(id)
		.first<{ id: string }>();
	if (!site) return c.json({ error: "not found" }, 404);

	const limit = Math.min(Number(c.req.query("limit") ?? "20"), 100);
	const offset = Number(c.req.query("offset") ?? "0");

	const { results } = await c.env.DB.prepare(
		"SELECT * FROM change_history WHERE site_id = ? ORDER BY detected_at DESC LIMIT ? OFFSET ?",
	)
		.bind(id, limit, offset)
		.all<ChangeHistory>();

	const total = await c.env.DB.prepare(
		"SELECT COUNT(*) as n FROM change_history WHERE site_id = ?",
	)
		.bind(id)
		.first<{ n: number }>();

	return c.json({ history: results, total: total?.n ?? 0, limit, offset });
});

// GET /config — global webhook URL
app.get("/config", async (c) => {
	const row = await c.env.DB.prepare("SELECT value FROM config WHERE key = ?")
		.bind("webhook_url")
		.first<{ value: string }>();
	return c.json({ webhook_url: row?.value ?? "" });
});

// PUT /config — set global webhook URL
app.put("/config", async (c) => {
	const body = await c.req.json<{ webhook_url: string }>();
	if (typeof body.webhook_url !== "string")
		return c.json({ error: "webhook_url is required" }, 400);
	if (body.webhook_url && !body.webhook_url.startsWith("https://")) {
		return c.json({ error: "webhook_url must start with https://" }, 400);
	}
	await c.env.DB.prepare(
		"INSERT OR REPLACE INTO config(key, value) VALUES (?, ?)",
	)
		.bind("webhook_url", body.webhook_url)
		.run();
	return c.json({ ok: true, webhook_url: body.webhook_url });
});

// POST /cron/trigger — manually fire a cron cycle (useful for testing)
app.post("/cron/trigger", async (c) => {
	const result = await runCron(c.env);
	return c.json({ ok: true, ...result });
});

// ── Worker export ─────────────────────────────────────────────────────────

export default {
	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		console.log(`[site-monitor] cron fired at ${new Date().toISOString()}`);
		ctx.waitUntil(
			runCron(env).then(({ checked, changed, errors }) => {
				console.log(
					`[site-monitor] done — checked=${checked} changed=${changed} errors=${errors}`,
				);
			}),
		);
	},

	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return app.fetch(request, env, ctx);
	},
};
