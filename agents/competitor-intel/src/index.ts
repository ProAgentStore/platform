/**
 * competitor-intel — daily competitor tracking agent.
 *
 * Cron fires at 07:00 UTC. For each configured competitor URL it:
 *   1. Fetches the page (plain text, stripped of tags)
 *   2. Hashes the content and compares to the previous hash
 *   3. If changed, calls Workers AI to summarize what changed
 *   4. Stores a report in the CompetitorIntelDO
 *
 * API (protected by bearer ADMIN_TOKEN where noted):
 *   POST /competitors          [auth] — add competitor URL
 *   DELETE /competitors/:id    [auth] — remove competitor
 *   GET  /competitors          — list all competitors
 *   GET  /reports              — list report summaries (latest first)
 *   GET  /reports/latest       — full latest report
 */

import { DurableObject } from "cloudflare:workers";
import { type Context, Hono } from "hono";

// ── Types ──────────────────────────────────────────────────────

interface Env {
	AI: Ai;
	INTEL: DurableObjectNamespace;
	ADMIN_TOKEN?: string;
}

interface Competitor {
	id: string;
	url: string;
	label: string;
	addedAt: string;
}

interface CompetitorState {
	hash: string;
	lastFetchedAt: string;
	lastChangedAt: string | null;
}

interface ReportEntry {
	id: string; // ISO timestamp used as key
	generatedAt: string;
	competitorsChecked: number;
	changesDetected: number;
	summary: string; // AI-generated overall summary
	items: ReportItem[];
}

interface ReportItem {
	competitorId: string;
	url: string;
	label: string;
	changed: boolean;
	changeSummary: string | null; // null if unchanged
}

// ── Helpers ────────────────────────────────────────────────────

/** SHA-256 hex of a string, using the Web Crypto API available in Workers. */
async function sha256(text: string): Promise<string> {
	const buf = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** Fetch a URL and return its text content with HTML tags stripped. */
async function fetchText(url: string): Promise<string> {
	const res = await fetch(url, {
		headers: { "User-Agent": "CompetitorIntelBot/1.0 (ProAgentStore)" },
		redirect: "follow",
		// 10-second timeout via signal
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	const html = await res.text();
	// Strip tags, collapse whitespace — good enough for change detection
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Call Workers AI to summarize the diff between two page snapshots. */
async function summarizeChange(
	ai: Ai,
	url: string,
	label: string,
	previous: string,
	current: string,
): Promise<string> {
	// Truncate to keep prompt within model limits
	const prev = previous.slice(0, 2000);
	const curr = current.slice(0, 2000);

	const result = (await ai.run(
		"@cf/meta/llama-3.3-70b-instruct-fp8-fast" as Parameters<Ai["run"]>[0],
		{
			messages: [
				{
					role: "system",
					content:
						"You are a competitive intelligence analyst. Given two snapshots of a competitor web page, describe what changed concisely (2-4 sentences). Focus on meaningful changes: new features, pricing shifts, messaging changes, new products. Ignore trivial wording tweaks.",
				},
				{
					role: "user",
					content: `Competitor: ${label} (${url})\n\nPREVIOUS:\n${prev}\n\nCURRENT:\n${curr}`,
				},
			],
		},
	)) as { response?: string };

	return result.response?.trim() ?? "Unable to summarize change.";
}

/** Call Workers AI to generate an overall intelligence report summary. */
async function generateReportSummary(
	ai: Ai,
	items: ReportItem[],
): Promise<string> {
	const changed = items.filter((i) => i.changed);
	if (changed.length === 0) {
		return "No competitor changes detected today.";
	}

	const bullets = changed
		.map((i) => `- ${i.label}: ${i.changeSummary}`)
		.join("\n");

	const result = (await ai.run(
		"@cf/meta/llama-3.3-70b-instruct-fp8-fast" as Parameters<Ai["run"]>[0],
		{
			messages: [
				{
					role: "system",
					content:
						"You are a senior competitive intelligence analyst. Given individual change summaries for competitors, write a concise executive briefing (3-5 sentences) highlighting the most strategically important developments and any patterns you notice.",
				},
				{
					role: "user",
					content: `Today's competitor changes:\n${bullets}`,
				},
			],
		},
	)) as { response?: string };

	return (
		result.response?.trim() ?? "See individual competitor summaries below."
	);
}

// ── Hono API ───────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

type AppContext = Context<{ Bindings: Env }>;

/** Require ADMIN_TOKEN bearer auth. Skip if token not configured (dev mode). */
function requireAuth(c: AppContext): Response | null {
	const token = c.env.ADMIN_TOKEN;
	if (token) {
		const header = c.req.header("Authorization") ?? "";
		if (header !== `Bearer ${token}`) {
			return c.json({ error: "Unauthorized" }, 401);
		}
	}
	return null;
}

app.get("/", (c) =>
	c.json({ agent: "competitor-intel", status: "ok", version: "0.0.1" }),
);

// ── Competitor management ──────────────────────────────────────

app.get("/competitors", async (c) => {
	const doId = c.env.INTEL.idFromName("main");
	const stub = c.env.INTEL.get(doId);
	const res = await stub.fetch(new Request("http://do/competitors"));
	return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/competitors", async (c) => {
	const authRes = requireAuth(c);
	if (authRes) return authRes;

	const body = await c.req.json<{ url: string; label?: string }>();
	if (!body.url) return c.json({ error: "url is required" }, 400);

	try {
		new URL(body.url);
	} catch {
		return c.json({ error: "url is not a valid URL" }, 400);
	}

	const doId = c.env.INTEL.idFromName("main");
	const stub = c.env.INTEL.get(doId);
	const res = await stub.fetch(
		new Request("http://do/competitors", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
	return new Response(res.body, { status: res.status, headers: res.headers });
});

app.delete("/competitors/:id", async (c) => {
	const authRes = requireAuth(c);
	if (authRes) return authRes;

	const doId = c.env.INTEL.idFromName("main");
	const stub = c.env.INTEL.get(doId);
	const res = await stub.fetch(
		new Request(`http://do/competitors/${c.req.param("id")}`, {
			method: "DELETE",
		}),
	);
	return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Reports ────────────────────────────────────────────────────

app.get("/reports", async (c) => {
	const limit = Math.min(Number(c.req.query("limit") ?? "20"), 100);
	const doId = c.env.INTEL.idFromName("main");
	const stub = c.env.INTEL.get(doId);
	const res = await stub.fetch(new Request(`http://do/reports?limit=${limit}`));
	return new Response(res.body, { status: res.status, headers: res.headers });
});

app.get("/reports/latest", async (c) => {
	const doId = c.env.INTEL.idFromName("main");
	const stub = c.env.INTEL.get(doId);
	const res = await stub.fetch(new Request("http://do/reports/latest"));
	return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Default export — cron + fetch ─────────────────────────────

export default {
	/** Cron: runs the daily competitive intelligence sweep. */
	async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
		console.log(`competitor-intel cron fired at ${new Date().toISOString()}`);

		const doId = env.INTEL.idFromName("main");
		const stub = env.INTEL.get(doId);

		// Load competitors from the DO
		const competitorsRes = await stub.fetch(
			new Request("http://do/competitors"),
		);
		const { competitors } = await competitorsRes.json<{
			competitors: Competitor[];
		}>();

		if (competitors.length === 0) {
			console.log("No competitors configured, skipping run.");
			return;
		}

		const items: ReportItem[] = [];

		for (const comp of competitors) {
			let text: string;
			try {
				text = await fetchText(comp.url);
			} catch (err) {
				console.error(`Failed to fetch ${comp.url}:`, err);
				items.push({
					competitorId: comp.id,
					url: comp.url,
					label: comp.label,
					changed: false,
					changeSummary: `Fetch error: ${(err as Error).message}`,
				});
				continue;
			}

			const hash = await sha256(text);

			// Load previous state from DO
			const stateRes = await stub.fetch(
				new Request(`http://do/state/${comp.id}`),
			);
			const prevState = stateRes.ok
				? await stateRes.json<CompetitorState | null>()
				: null;

			const changed = prevState !== null && prevState.hash !== hash;
			let changeSummary: string | null = null;

			if (changed && prevState) {
				// Load the previous content snapshot for diffing
				const snapRes = await stub.fetch(
					new Request(`http://do/snapshot/${comp.id}`),
				);
				const prevText = snapRes.ok ? await snapRes.text() : "";
				changeSummary = await summarizeChange(
					env.AI,
					comp.url,
					comp.label,
					prevText,
					text,
				);
			}

			// Persist new state + snapshot
			await stub.fetch(
				new Request(`http://do/state/${comp.id}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						hash,
						lastFetchedAt: new Date().toISOString(),
						lastChangedAt: changed
							? new Date().toISOString()
							: (prevState?.lastChangedAt ?? null),
					} satisfies CompetitorState),
				}),
			);
			await stub.fetch(
				new Request(`http://do/snapshot/${comp.id}`, {
					method: "PUT",
					headers: { "Content-Type": "text/plain" },
					body: text,
				}),
			);

			items.push({
				competitorId: comp.id,
				url: comp.url,
				label: comp.label,
				changed,
				changeSummary,
			});
		}

		const summary = await generateReportSummary(env.AI, items);
		const report: ReportEntry = {
			id: new Date().toISOString(),
			generatedAt: new Date().toISOString(),
			competitorsChecked: competitors.length,
			changesDetected: items.filter((i) => i.changed).length,
			summary,
			items,
		};

		await stub.fetch(
			new Request("http://do/reports", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(report),
			}),
		);

		console.log(
			`competitor-intel done: checked=${report.competitorsChecked} changed=${report.changesDetected}`,
		);
	},

	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return app.fetch(request, env, ctx);
	},
};

// ── Durable Object ─────────────────────────────────────────────

/**
 * CompetitorIntelDO holds all mutable state:
 *  - competitors list           key: "competitors"
 *  - per-competitor hash+dates  key: "state:<id>"
 *  - per-competitor text snap   key: "snap:<id>"
 *  - reports (latest 90)        key: "report:<iso-ts>"
 */
export class CompetitorIntelDO extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const { method } = request;
		const path = url.pathname;

		// GET /competitors
		if (path === "/competitors" && method === "GET") {
			const list =
				(await this.ctx.storage.get<Competitor[]>("competitors")) ?? [];
			return json({ competitors: list });
		}

		// POST /competitors
		if (path === "/competitors" && method === "POST") {
			const { url: compUrl, label } = await request.json<{
				url: string;
				label?: string;
			}>();
			const list =
				(await this.ctx.storage.get<Competitor[]>("competitors")) ?? [];
			const id = crypto.randomUUID();
			const competitor: Competitor = {
				id,
				url: compUrl,
				label: label ?? new URL(compUrl).hostname,
				addedAt: new Date().toISOString(),
			};
			list.push(competitor);
			await this.ctx.storage.put("competitors", list);
			return json(competitor, 201);
		}

		// DELETE /competitors/:id
		const deleteMatch = path.match(/^\/competitors\/([^/]+)$/);
		if (deleteMatch && method === "DELETE") {
			const id = deleteMatch[1];
			const list =
				(await this.ctx.storage.get<Competitor[]>("competitors")) ?? [];
			const next = list.filter((c) => c.id !== id);
			if (next.length === list.length) return json({ error: "Not found" }, 404);
			await this.ctx.storage.put("competitors", next);
			// Clean up state + snapshot
			await this.ctx.storage.delete(`state:${id}`);
			await this.ctx.storage.delete(`snap:${id}`);
			return json({ deleted: id });
		}

		// GET /state/:id
		const stateGetMatch = path.match(/^\/state\/([^/]+)$/);
		if (stateGetMatch && method === "GET") {
			const id = stateGetMatch[1];
			const state = await this.ctx.storage.get<CompetitorState>(`state:${id}`);
			if (!state) return new Response(null, { status: 404 });
			return json(state);
		}

		// PUT /state/:id
		const statePutMatch = path.match(/^\/state\/([^/]+)$/);
		if (statePutMatch && method === "PUT") {
			const id = statePutMatch[1];
			const state = await request.json<CompetitorState>();
			await this.ctx.storage.put(`state:${id}`, state);
			return json({ ok: true });
		}

		// GET /snapshot/:id
		const snapGetMatch = path.match(/^\/snapshot\/([^/]+)$/);
		if (snapGetMatch && method === "GET") {
			const id = snapGetMatch[1];
			const snap = await this.ctx.storage.get<string>(`snap:${id}`);
			if (snap == null) return new Response("", { status: 404 });
			return new Response(snap, { headers: { "Content-Type": "text/plain" } });
		}

		// PUT /snapshot/:id
		const snapPutMatch = path.match(/^\/snapshot\/([^/]+)$/);
		if (snapPutMatch && method === "PUT") {
			const id = snapPutMatch[1];
			const text = await request.text();
			// Store truncated — no need to keep multi-MB snapshots
			await this.ctx.storage.put(`snap:${id}`, text.slice(0, 50_000));
			return json({ ok: true });
		}

		// POST /reports
		if (path === "/reports" && method === "POST") {
			const report = await request.json<ReportEntry>();
			await this.ctx.storage.put(`report:${report.id}`, report);
			await this.pruneReports(90);
			return json({ ok: true }, 201);
		}

		// GET /reports?limit=N
		if (path === "/reports" && method === "GET") {
			const limit = Math.min(
				Number(url.searchParams.get("limit") ?? "20"),
				100,
			);
			const entries = await this.ctx.storage.list<ReportEntry>({
				prefix: "report:",
				reverse: true,
				limit,
			});
			// Return summaries (no items array) for the list view
			const summaries = [...entries.values()].map(
				({ items: _items, ...r }) => r,
			);
			return json({ reports: summaries });
		}

		// GET /reports/latest
		if (path === "/reports/latest" && method === "GET") {
			const entries = await this.ctx.storage.list<ReportEntry>({
				prefix: "report:",
				reverse: true,
				limit: 1,
			});
			const report = [...entries.values()][0];
			if (!report) return json({ error: "No reports yet" }, 404);
			return json(report);
		}

		return new Response("Not found", { status: 404 });
	}

	/** Remove reports beyond the retention limit (oldest first). */
	private async pruneReports(keep: number): Promise<void> {
		const all = await this.ctx.storage.list<ReportEntry>({
			prefix: "report:",
			reverse: false, // ascending = oldest first
		});
		const keys = [...all.keys()];
		if (keys.length > keep) {
			const toDelete = keys.slice(0, keys.length - keep);
			await Promise.all(toDelete.map((k) => this.ctx.storage.delete(k)));
		}
	}
}

// ── Tiny response helper ───────────────────────────────────────

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
