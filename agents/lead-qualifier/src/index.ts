/**
 * lead-qualifier — ProAgentStore agent.
 *
 * Receives form submissions via webhook, scores them with Workers AI
 * (hot / warm / cold), persists leads in a Durable Object, and fires
 * an outbound webhook notification for every hot lead.
 *
 * Routes
 * ------
 * POST /webhook/ingest          — receive a new lead (form submission)
 * GET  /leads                   — list all leads (optional ?status= filter)
 * GET  /leads/:id               — get a single lead with full AI notes
 * PUT  /leads/:id/status        — manually update lead status
 * GET  /stats                   — aggregate counts + conversion metrics
 */

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

// ── Types ──────────────────────────────────────────────────────────────────

interface Env {
	AI: Ai;
	LEADS: DurableObjectNamespace;
	/** Shared secret callers must send in X-Webhook-Secret header. Optional. */
	WEBHOOK_SECRET?: string;
	/** URL to POST hot lead notifications to (Slack, n8n, Zapier, etc.). Optional. */
	NOTIFY_WEBHOOK?: string;
}

type LeadScore = "hot" | "warm" | "cold";
type LeadStatus =
	| "new"
	| "contacted"
	| "qualified"
	| "disqualified"
	| "converted";

interface LeadInput {
	name: string;
	email: string;
	company?: string;
	message?: string;
	/** Any extra fields from the form (budget, phone, role, …) */
	[key: string]: string | undefined;
}

interface Lead {
	id: string;
	name: string;
	email: string;
	company: string;
	message: string;
	/** Freeform extra fields captured from the form */
	extra: Record<string, string>;
	score: LeadScore;
	/** Numeric 0-100 from the AI */
	scoreValue: number;
	/** AI-generated reasoning for the score */
	notes: string;
	status: LeadStatus;
	createdAt: string;
	updatedAt: string;
}

interface ScoringCriteria {
	/** Words/phrases in company name or message that signal high intent */
	hotSignals: string[];
	/** Words/phrases that signal low intent */
	coldSignals: string[];
	/** Min numeric score (0-100) to classify as "hot". Default: 70 */
	hotThreshold: number;
	/** Min numeric score to classify as "warm". Default: 40 */
	warmThreshold: number;
}

interface Stats {
	total: number;
	byScore: Record<LeadScore, number>;
	byStatus: Record<LeadStatus, number>;
	conversionRate: number;
}

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_CRITERIA: ScoringCriteria = {
	hotSignals: [
		"urgent",
		"asap",
		"immediately",
		"ready to buy",
		"ready to start",
		"enterprise",
		"budget approved",
		"decision maker",
		"ceo",
		"cto",
		"vp",
		"looking for a solution",
		"evaluating",
		"demo",
	],
	coldSignals: [
		"just curious",
		"student",
		"research",
		"no budget",
		"someday",
		"maybe",
		"not sure",
		"free",
		"cheap",
	],
	hotThreshold: 70,
	warmThreshold: 40,
};

const SCORING_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as Parameters<
	Ai["run"]
>[0];

// ── Hono API ─────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

/** Get the singleton LeadStoreDO stub */
function getLeadStore(env: Env): DurableObjectStub {
	const id = env.LEADS.idFromName("store");
	return env.LEADS.get(id);
}

function doFetch(
	stub: DurableObjectStub,
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return stub.fetch(new Request(`http://internal${path}`, init));
}

// ── Health ───────────────────────────────────────────────────────────────────

app.get("/", (c) =>
	c.json({ agent: "lead-qualifier", type: "agent", status: "ok" }),
);

// ── Webhook ingest ───────────────────────────────────────────────────────────

app.post("/webhook/ingest", async (c) => {
	// Optional shared-secret auth
	const secret = c.env.WEBHOOK_SECRET;
	if (secret) {
		const provided = c.req.header("x-webhook-secret");
		if (provided !== secret) {
			return c.json({ error: "Unauthorized" }, 401);
		}
	}

	let body: LeadInput;
	try {
		body = await c.req.json<LeadInput>();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const { name, email, company, message, ...extra } = body;

	if (!name || !email) {
		return c.json({ error: "name and email are required" }, 400);
	}

	// Score the lead with Workers AI
	const { score, scoreValue, notes } = await scoreLead(
		c.env.AI,
		{
			name,
			email,
			company: company || "",
			message: message || "",
			extra,
		},
		DEFAULT_CRITERIA,
	);

	// Build the lead record
	const lead: Lead = {
		id: crypto.randomUUID(),
		name,
		email,
		company: company || "",
		message: message || "",
		extra: Object.fromEntries(
			Object.entries(extra).filter(([, v]) => typeof v === "string") as [
				string,
				string,
			][],
		),
		score,
		scoreValue,
		notes,
		status: "new",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	// Persist in DO
	const stub = getLeadStore(c.env);
	const saveRes = await doFetch(stub, "/leads", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(lead),
	});
	if (!saveRes.ok) {
		return c.json({ error: "Failed to persist lead" }, 500);
	}

	// Fire outbound notification for hot leads
	if (score === "hot" && c.env.NOTIFY_WEBHOOK) {
		c.executionCtx.waitUntil(notifyHotLead(c.env.NOTIFY_WEBHOOK, lead));
	}

	return c.json({ id: lead.id, score, scoreValue, status: lead.status }, 201);
});

// ── Lead management ──────────────────────────────────────────────────────────

app.get("/leads", async (c) => {
	const status = c.req.query("status") as LeadStatus | undefined;
	const score = c.req.query("score") as LeadScore | undefined;
	const stub = getLeadStore(c.env);
	const params = new URLSearchParams();
	if (status) params.set("status", status);
	if (score) params.set("score", score);
	const res = await doFetch(stub, `/leads?${params}`);
	return new Response(res.body, { status: res.status, headers: res.headers });
});

app.get("/leads/:id", async (c) => {
	const stub = getLeadStore(c.env);
	const res = await doFetch(stub, `/leads/${c.req.param("id")}`);
	return new Response(res.body, { status: res.status, headers: res.headers });
});

app.put("/leads/:id/status", async (c) => {
	let body: { status: LeadStatus };
	try {
		body = await c.req.json<{ status: LeadStatus }>();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const validStatuses: LeadStatus[] = [
		"new",
		"contacted",
		"qualified",
		"disqualified",
		"converted",
	];
	if (!validStatuses.includes(body.status)) {
		return c.json(
			{ error: `status must be one of: ${validStatuses.join(", ")}` },
			400,
		);
	}

	const stub = getLeadStore(c.env);
	const res = await doFetch(stub, `/leads/${c.req.param("id")}/status`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ status: body.status }),
	});
	return new Response(res.body, { status: res.status, headers: res.headers });
});

app.get("/stats", async (c) => {
	const stub = getLeadStore(c.env);
	const res = await doFetch(stub, "/stats");
	return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── Global error handler ─────────────────────────────────────────────────────

app.onError((err, c) => {
	console.error("Unhandled error:", err.message, err.stack);
	return c.json({ error: "Internal server error" }, 500);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

export default app;

// ── Durable Object ────────────────────────────────────────────────────────────

/**
 * LeadStoreDO — one global singleton that holds all leads for this agent.
 *
 * Storage layout:
 *   lead:<id>   → Lead object
 */
export class LeadStoreDO extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		try {
			// POST /leads — save new lead
			if (path === "/leads" && request.method === "POST") {
				const lead = await request.json<Lead>();
				await this.ctx.storage.put(`lead:${lead.id}`, lead);
				return json(lead, 201);
			}

			// GET /leads — list, with optional ?status= and ?score= filters
			if (path === "/leads" && request.method === "GET") {
				const statusFilter = url.searchParams.get(
					"status",
				) as LeadStatus | null;
				const scoreFilter = url.searchParams.get("score") as LeadScore | null;
				const all = await this.ctx.storage.list<Lead>({ prefix: "lead:" });
				let leads = [...all.values()].sort(
					(a, b) =>
						new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
				);
				if (statusFilter)
					leads = leads.filter((l) => l.status === statusFilter);
				if (scoreFilter) leads = leads.filter((l) => l.score === scoreFilter);
				return json({ leads, total: leads.length });
			}

			// GET /leads/:id
			const leadMatch = path.match(/^\/leads\/([^/]+)$/);
			if (leadMatch && request.method === "GET") {
				const lead = await this.ctx.storage.get<Lead>(`lead:${leadMatch[1]}`);
				if (!lead) return json({ error: "Lead not found" }, 404);
				return json(lead);
			}

			// PUT /leads/:id/status
			const statusMatch = path.match(/^\/leads\/([^/]+)\/status$/);
			if (statusMatch && request.method === "PUT") {
				const lead = await this.ctx.storage.get<Lead>(`lead:${statusMatch[1]}`);
				if (!lead) return json({ error: "Lead not found" }, 404);
				const { status } = await request.json<{ status: LeadStatus }>();
				const updated: Lead = {
					...lead,
					status,
					updatedAt: new Date().toISOString(),
				};
				await this.ctx.storage.put(`lead:${lead.id}`, updated);
				return json(updated);
			}

			// GET /stats
			if (path === "/stats" && request.method === "GET") {
				return json(await this.computeStats());
			}

			return json({ error: "Not found" }, 404);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("LeadStoreDO error:", msg);
			return json({ error: msg }, 500);
		}
	}

	private async computeStats(): Promise<Stats> {
		const all = await this.ctx.storage.list<Lead>({ prefix: "lead:" });
		const leads = [...all.values()];

		const byScore: Record<LeadScore, number> = { hot: 0, warm: 0, cold: 0 };
		const byStatus: Record<LeadStatus, number> = {
			new: 0,
			contacted: 0,
			qualified: 0,
			disqualified: 0,
			converted: 0,
		};

		for (const lead of leads) {
			byScore[lead.score]++;
			byStatus[lead.status]++;
		}

		const total = leads.length;
		const converted = byStatus.converted;
		const conversionRate =
			total > 0 ? Math.round((converted / total) * 10000) / 100 : 0;

		return { total, byScore, byStatus, conversionRate };
	}
}

// ── AI scoring ────────────────────────────────────────────────────────────────

async function scoreLead(
	ai: Ai,
	lead: {
		name: string;
		email: string;
		company: string;
		message: string;
		extra: Record<string, string | undefined>;
	},
	criteria: ScoringCriteria,
): Promise<{ score: LeadScore; scoreValue: number; notes: string }> {
	const extraText = Object.entries(lead.extra)
		.filter(([, v]) => v)
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n");

	const prompt = `You are a lead qualification expert. Score this inbound lead from 0 to 100 and classify it.

Scoring criteria:
- Signals of HIGH intent (push score up): ${criteria.hotSignals.join(", ")}
- Signals of LOW intent (push score down): ${criteria.coldSignals.join(", ")}
- Hot threshold: ${criteria.hotThreshold}+ → hot lead
- Warm threshold: ${criteria.warmThreshold}+ → warm lead
- Below ${criteria.warmThreshold} → cold lead

Lead details:
Name: ${lead.name}
Email: ${lead.email}
Company: ${lead.company || "(not provided)"}
Message: ${lead.message || "(not provided)"}
${extraText ? `Additional fields:\n${extraText}` : ""}

Respond with ONLY valid JSON in exactly this format — no markdown, no explanation:
{"score": <0-100 integer>, "classification": "hot" | "warm" | "cold", "notes": "<2-3 sentence reasoning>"}`;

	let scoreValue = 50;
	let score: LeadScore = "warm";
	let notes = "Unable to score — defaulting to warm.";

	try {
		const result = (await ai.run(SCORING_MODEL, {
			messages: [
				{
					role: "system",
					content: "You are a lead scoring assistant. Output only valid JSON.",
				},
				{ role: "user", content: prompt },
			],
		})) as { response?: string };

		const raw = (result.response || "").trim();

		// Extract JSON object even if the model wraps it in markdown fences
		const jsonMatch = raw.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = JSON.parse(jsonMatch[0]) as {
				score?: number;
				classification?: string;
				notes?: string;
			};

			if (typeof parsed.score === "number") {
				scoreValue = Math.max(0, Math.min(100, Math.round(parsed.score)));
			}
			if (
				parsed.classification === "hot" ||
				parsed.classification === "warm" ||
				parsed.classification === "cold"
			) {
				score = parsed.classification;
			} else {
				// Derive from numeric score if model classification is missing/wrong
				score =
					scoreValue >= criteria.hotThreshold
						? "hot"
						: scoreValue >= criteria.warmThreshold
							? "warm"
							: "cold";
			}
			if (parsed.notes) notes = parsed.notes;
		}
	} catch (err) {
		console.error(
			"AI scoring failed:",
			err instanceof Error ? err.message : String(err),
		);
		// Fall back to heuristic scoring
		const text = `${lead.company} ${lead.message}`.toLowerCase();
		const hotHits = criteria.hotSignals.filter((s) => text.includes(s)).length;
		const coldHits = criteria.coldSignals.filter((s) =>
			text.includes(s),
		).length;
		scoreValue = Math.max(0, Math.min(100, 50 + hotHits * 10 - coldHits * 15));
		score =
			scoreValue >= criteria.hotThreshold
				? "hot"
				: scoreValue >= criteria.warmThreshold
					? "warm"
					: "cold";
		notes = "Scored via keyword heuristics (AI unavailable).";
	}

	return { score, scoreValue, notes };
}

// ── Outbound webhook ─────────────────────────────────────────────────────────

async function notifyHotLead(webhookUrl: string, lead: Lead): Promise<void> {
	try {
		await fetch(webhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				event: "hot_lead",
				lead: {
					id: lead.id,
					name: lead.name,
					email: lead.email,
					company: lead.company,
					message: lead.message,
					scoreValue: lead.scoreValue,
					notes: lead.notes,
					createdAt: lead.createdAt,
				},
			}),
		});
	} catch (err) {
		console.error(
			"Hot lead notification failed:",
			err instanceof Error ? err.message : String(err),
		);
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
