/**
 * meeting-notes — ProAgentStore agent.
 *
 * Processes meeting transcripts via webhook. Workers AI extracts structured
 * notes (summary, action items, decisions, follow-ups, attendees) and stores
 * them in a Durable Object. A daily cron fires at 18:00 UTC with a digest of
 * all open action items from the past 7 days.
 *
 * API
 * ---
 * POST /webhook/transcript        — ingest a transcript, returns extracted notes
 * GET  /meetings                  — list meetings (newest first, ?limit=&cursor=&search=)
 * GET  /meetings/:id              — get a single meeting with full notes
 * GET  /action-items              — list all action items (?status=open|done)
 * PUT  /action-items/:id          — update an action item (mark done, reassign)
 * GET  /digest                    — on-demand digest (same as cron output)
 * POST /cron/trigger              — manually run the cron cycle (dev/debug)
 * GET  /health                    — liveness probe
 */

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

// ── Types ─────────────────────────────────────────────────────────────────

export interface Env {
	AI: Ai;
	MEETINGS: DurableObjectNamespace;
	/** Optional shared secret — callers must send X-Webhook-Secret: <value>. */
	WEBHOOK_SECRET?: string;
	/** Optional URL to POST the daily digest to (Slack, n8n, email relay, etc.). */
	DIGEST_WEBHOOK?: string;
}

interface ActionItem {
	id: string;
	meetingId: string;
	meetingTitle: string;
	meetingDate: string;
	text: string;
	assignee: string;
	dueDate: string;
	/** "open" | "done" */
	status: "open" | "done";
}

interface Meeting {
	id: string;
	title: string;
	source: string;
	attendees: string[];
	date: string;
	transcript: string;
	summary: string;
	decisions: string[];
	followUps: string[];
	actionItems: ActionItem[];
	createdAt: string;
}

interface ExtractedNotes {
	title: string;
	attendees: string[];
	summary: string;
	decisions: string[];
	followUps: string[];
	actionItems: Array<{
		text: string;
		assignee: string;
		dueDate: string;
	}>;
}

// ── AI extraction ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a meeting notes assistant. Extract structured information from meeting transcripts.
Always respond with valid JSON only — no markdown fences, no extra commentary.`;

function buildExtractionPrompt(transcript: string, source: string): string {
	return `Extract structured notes from this ${source} meeting transcript.

Transcript:
${transcript.slice(0, 12000)}

Return a JSON object with exactly these fields:
{
  "title": "short descriptive title for this meeting (max 80 chars)",
  "attendees": ["list of names mentioned as participants"],
  "summary": "2-4 sentence executive summary of what was discussed and decided",
  "decisions": ["list of firm decisions made in this meeting"],
  "followUps": ["list of topics that need follow-up discussion in a future meeting"],
  "actionItems": [
    {
      "text": "specific task to be done",
      "assignee": "person responsible (or 'unassigned')",
      "dueDate": "due date if mentioned, otherwise empty string"
    }
  ]
}

Rules:
- Be concrete and specific. No vague items.
- Action items must be actionable tasks, not discussion points.
- Decisions must be things agreed upon, not things still open.
- If a field has no content, use an empty array.
- Do not invent information not present in the transcript.`;
}

async function extractNotes(
	ai: Ai,
	transcript: string,
	source: string,
): Promise<ExtractedNotes> {
	const result = (await ai.run(
		"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		{
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: buildExtractionPrompt(transcript, source) },
			],
		},
	)) as { response?: string };

	const raw = result.response?.trim() ?? "";

	try {
		return JSON.parse(raw) as ExtractedNotes;
		} catch {
			// AI returned malformed JSON — return a minimal fallback so we never
			// lose the transcript. The caller can re-process if needed.
			console.error("[meeting-notes] AI returned non-JSON response:", raw.slice(0, 200));
			return {
				title: `Meeting ${new Date().toISOString().slice(0, 10)}`,
				attendees: [],
				summary: raw.slice(0, 500) || "Could not extract summary.",
				decisions: [],
			followUps: [],
			actionItems: [],
		};
	}
}

// ── Durable Object — stores all meetings + action items ───────────────────

/**
 * MeetingsDO
 *
 * Storage layout (ctx.storage keys):
 *   meeting:<id>          — Meeting object
 *   action:<id>           — ActionItem object
 *   index:meeting:<id>    — ISO date string (for time-ordered list scans)
 *
 * Internal routes (Worker → DO fetch):
 *   POST /meetings                 — store a new meeting
 *   GET  /meetings                 — list all meetings (query: limit, cursor, search)
 *   GET  /meetings/:id             — get one meeting
 *   GET  /action-items             — list all action items (query: status)
 *   PUT  /action-items/:id         — patch an action item
 */
export class MeetingsDO extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;
		const method = request.method;

		// ── POST /meetings ─────────────────────────────────────────────
		if (pathname === "/meetings" && method === "POST") {
			const meeting = await request.json<Meeting>();
			await this.ctx.storage.put(`meeting:${meeting.id}`, meeting);
			// Store each action item separately for efficient queries
			for (const item of meeting.actionItems) {
				await this.ctx.storage.put(`action:${item.id}`, item);
			}
			return json(meeting, 201);
		}

		// ── GET /meetings ──────────────────────────────────────────────
		if (pathname === "/meetings" && method === "GET") {
			const limit = Math.min(Number(url.searchParams.get("limit") ?? "20"), 100);
			const search = (url.searchParams.get("search") ?? "").toLowerCase().trim();

			const entries = await this.ctx.storage.list<Meeting>({ prefix: "meeting:" });
			let meetings = [...entries.values()].sort((a, b) =>
				b.createdAt.localeCompare(a.createdAt),
			);

			if (search) {
				meetings = meetings.filter(
					(m) =>
						m.title.toLowerCase().includes(search) ||
						m.summary.toLowerCase().includes(search) ||
						m.attendees.some((a) => a.toLowerCase().includes(search)),
				);
			}

			const total = meetings.length;
			const cursor = Number(url.searchParams.get("cursor") ?? "0");
			const page = meetings.slice(cursor, cursor + limit);
			const nextCursor = cursor + limit < total ? cursor + limit : null;

			return json({
				meetings: page.map(meetingSummary),
				total,
				cursor,
				nextCursor,
			});
		}

		// ── GET /meetings/:id ──────────────────────────────────────────
		const meetingMatch = pathname.match(/^\/meetings\/([^/]+)$/);
		if (meetingMatch && method === "GET") {
			const id = meetingMatch[1];
			const meeting = await this.ctx.storage.get<Meeting>(`meeting:${id}`);
			if (!meeting) return notFound();
			return json(meeting);
		}

		// ── GET /action-items ──────────────────────────────────────────
		if (pathname === "/action-items" && method === "GET") {
			const status = url.searchParams.get("status") as "open" | "done" | null;
			const entries = await this.ctx.storage.list<ActionItem>({ prefix: "action:" });
			let items = [...entries.values()].sort((a, b) =>
				b.meetingDate.localeCompare(a.meetingDate),
			);
			if (status) {
				items = items.filter((i) => i.status === status);
			}
			return json({ actionItems: items, total: items.length });
		}

		// ── PUT /action-items/:id ──────────────────────────────────────
		const actionMatch = pathname.match(/^\/action-items\/([^/]+)$/);
		if (actionMatch && method === "PUT") {
			const id = actionMatch[1];
			const item = await this.ctx.storage.get<ActionItem>(`action:${id}`);
			if (!item) return notFound();

			const patch = await request.json<Partial<Pick<ActionItem, "status" | "assignee" | "dueDate">>>();
			if (patch.status !== undefined) {
				if (patch.status !== "open" && patch.status !== "done") {
					return json({ error: "status must be 'open' or 'done'" }, 400);
				}
				item.status = patch.status;
			}
			if (patch.assignee !== undefined) item.assignee = patch.assignee;
			if (patch.dueDate !== undefined) item.dueDate = patch.dueDate;

			await this.ctx.storage.put(`action:${id}`, item);

			// Sync back into the parent meeting's actionItems array
			const meeting = await this.ctx.storage.get<Meeting>(`meeting:${item.meetingId}`);
			if (meeting) {
				meeting.actionItems = meeting.actionItems.map((a) =>
					a.id === id ? item : a,
				);
				await this.ctx.storage.put(`meeting:${item.meetingId}`, meeting);
			}

			return json(item);
		}

		// ── GET /digest-data (internal — cron use only) ────────────────
		if (pathname === "/digest-data" && method === "GET") {
			const since = new Date();
			since.setDate(since.getDate() - 7);
			const sinceISO = since.toISOString();

			const actionEntries = await this.ctx.storage.list<ActionItem>({ prefix: "action:" });
			const openItems = [...actionEntries.values()].filter(
				(i) => i.status === "open" && i.meetingDate >= sinceISO.slice(0, 10),
			);

			const meetingEntries = await this.ctx.storage.list<Meeting>({ prefix: "meeting:" });
			const recentMeetings = [...meetingEntries.values()]
				.filter((m) => m.createdAt >= sinceISO)
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

			return json({ openItems, recentMeetings });
		}

		return new Response("Not found", { status: 404 });
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function notFound(): Response {
	return json({ error: "not found" }, 404);
}

/** Return a lighter object for list views — omit the full transcript. */
function meetingSummary(m: Meeting) {
	return {
		id: m.id,
		title: m.title,
		source: m.source,
		attendees: m.attendees,
		date: m.date,
		summary: m.summary,
		decisionCount: m.decisions.length,
		actionItemCount: m.actionItems.length,
		openActionItemCount: m.actionItems.filter((a) => a.status === "open").length,
		createdAt: m.createdAt,
	};
}

function getMeetingsStub(env: Env) {
	return env.MEETINGS.get(env.MEETINGS.idFromName("main"));
}

function nanoid(len = 12): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let id = "";
	const bytes = crypto.getRandomValues(new Uint8Array(len));
	for (const b of bytes) id += chars[b % chars.length];
	return id;
}

// ── Digest builder ────────────────────────────────────────────────────────

interface DigestData {
	openItems: ActionItem[];
	recentMeetings: Meeting[];
}

function buildDigest(data: DigestData): string {
	const { openItems, recentMeetings } = data;
	const today = new Date().toISOString().slice(0, 10);
	const lines: string[] = [
		`Meeting Notes Daily Digest — ${today}`,
		"",
		`Meetings this week: ${recentMeetings.length}`,
		`Open action items: ${openItems.length}`,
		"",
	];

	if (recentMeetings.length > 0) {
		lines.push("--- Recent Meetings ---");
		for (const m of recentMeetings.slice(0, 10)) {
			lines.push(`• ${m.title} (${m.date || m.createdAt.slice(0, 10)}) — ${m.source}`);
			lines.push(`  ${m.summary}`);
		}
		lines.push("");
	}

	if (openItems.length > 0) {
		lines.push("--- Open Action Items ---");
		// Group by meeting
			const byMeeting = new Map<string, ActionItem[]>();
			for (const item of openItems) {
				const key = item.meetingTitle;
				const items = byMeeting.get(key) ?? [];
				items.push(item);
				byMeeting.set(key, items);
			}
		for (const [meetingTitle, items] of byMeeting) {
			lines.push(`${meetingTitle}:`);
			for (const item of items) {
				const due = item.dueDate ? ` (due ${item.dueDate})` : "";
				const who = item.assignee && item.assignee !== "unassigned" ? ` → ${item.assignee}` : "";
				lines.push(`  [ ] ${item.text}${who}${due}`);
			}
		}
	} else {
		lines.push("No open action items. All caught up!");
	}

	return lines.join("\n");
}

async function runDigest(env: Env): Promise<DigestData> {
	const stub = getMeetingsStub(env);
	const res = await stub.fetch(new Request("http://do/digest-data"));
	return res.json<DigestData>();
}

// ── Hono API ──────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) =>
	c.json({ agent: "meeting-notes", status: "ok" }),
);

// ── POST /webhook/transcript ───────────────────────────────────────────────

app.post("/webhook/transcript", async (c) => {
	// Optional secret check
	if (c.env.WEBHOOK_SECRET) {
		const sent = c.req.header("X-Webhook-Secret") ?? "";
		if (sent !== c.env.WEBHOOK_SECRET) {
			return c.json({ error: "unauthorized" }, 401);
		}
	}

	const body = await c.req.json<{
		transcript: string;
		source?: string;
		date?: string;
	}>().catch(() => null);

	if (!body?.transcript?.trim()) {
		return c.json({ error: "transcript is required" }, 400);
	}

	const source = body.source?.trim() || "unknown";
	const date = body.date?.trim() || new Date().toISOString().slice(0, 10);

	// Call Workers AI to extract structured notes
	let extracted: ExtractedNotes;
	try {
		extracted = await extractNotes(c.env.AI, body.transcript, source);
	} catch (err) {
		console.error("[meeting-notes] AI extraction failed:", err);
		return c.json({ error: "AI extraction failed", detail: String(err) }, 502);
	}

	const meetingId = nanoid();
	const now = new Date().toISOString();

	// Build action items with their own IDs
	const actionItems: ActionItem[] = extracted.actionItems.map((a) => ({
		id: nanoid(),
		meetingId,
		meetingTitle: extracted.title,
		meetingDate: date,
		text: a.text,
		assignee: a.assignee || "unassigned",
		dueDate: a.dueDate || "",
		status: "open",
	}));

	const meeting: Meeting = {
		id: meetingId,
		title: extracted.title,
		source,
		attendees: extracted.attendees,
		date,
		transcript: body.transcript,
		summary: extracted.summary,
		decisions: extracted.decisions,
		followUps: extracted.followUps,
		actionItems,
		createdAt: now,
	};

	// Persist in DO
	const stub = getMeetingsStub(c.env);
	await stub.fetch(
		new Request("http://do/meetings", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(meeting),
		}),
	);

	return c.json(
		{
			id: meetingId,
			title: meeting.title,
			attendees: meeting.attendees,
			summary: meeting.summary,
			decisions: meeting.decisions,
			followUps: meeting.followUps,
			actionItems,
		},
		201,
	);
});

// ── GET /meetings ──────────────────────────────────────────────────────────

app.get("/meetings", async (c) => {
	const stub = getMeetingsStub(c.env);
	const params = new URLSearchParams();
	const limit = c.req.query("limit");
	const cursor = c.req.query("cursor");
	const search = c.req.query("search");
	if (limit) params.set("limit", limit);
	if (cursor) params.set("cursor", cursor);
	if (search) params.set("search", search);

	const res = await stub.fetch(
		new Request(`http://do/meetings?${params.toString()}`),
	);
	return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── GET /meetings/:id ──────────────────────────────────────────────────────

app.get("/meetings/:id", async (c) => {
	const { id } = c.req.param();
	const stub = getMeetingsStub(c.env);
	const res = await stub.fetch(new Request(`http://do/meetings/${id}`));
	return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── GET /action-items ──────────────────────────────────────────────────────

app.get("/action-items", async (c) => {
	const stub = getMeetingsStub(c.env);
	const status = c.req.query("status");
	const params = status ? `?status=${status}` : "";
	const res = await stub.fetch(
		new Request(`http://do/action-items${params}`),
	);
	return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── PUT /action-items/:id ──────────────────────────────────────────────────

app.put("/action-items/:id", async (c) => {
	const { id } = c.req.param();
	const body = await c.req.json<Partial<Pick<ActionItem, "status" | "assignee" | "dueDate">>>().catch(
		() => null,
	);
	if (!body) return c.json({ error: "invalid JSON body" }, 400);

	const stub = getMeetingsStub(c.env);
	const res = await stub.fetch(
		new Request(`http://do/action-items/${id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
	return new Response(res.body, { status: res.status, headers: res.headers });
});

// ── GET /digest ────────────────────────────────────────────────────────────

app.get("/digest", async (c) => {
	const data = await runDigest(c.env);
	const text = buildDigest(data);
	const format = c.req.query("format");
	if (format === "json") {
		return c.json({
			generatedAt: new Date().toISOString(),
			openActionItems: data.openItems,
			recentMeetings: data.recentMeetings.map(meetingSummary),
			text,
		});
	}
	return c.text(text);
});

// ── POST /cron/trigger ─────────────────────────────────────────────────────

app.post("/cron/trigger", async (c) => {
	const data = await runDigest(c.env);
	const text = buildDigest(data);

	if (c.env.DIGEST_WEBHOOK) {
		try {
			await fetch(c.env.DIGEST_WEBHOOK, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					event: "daily_digest",
					generatedAt: new Date().toISOString(),
					openActionItems: data.openItems.length,
					recentMeetings: data.recentMeetings.length,
					text,
				}),
			});
		} catch (err) {
			console.error("[meeting-notes] Digest webhook delivery failed:", err);
		}
	}

	return c.json({
		ok: true,
		openActionItems: data.openItems.length,
		recentMeetings: data.recentMeetings.length,
		text,
	});
});

// ── Worker export ──────────────────────────────────────────────────────────

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return app.fetch(request, env, ctx);
	},

	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		console.log(`[meeting-notes] daily digest cron fired at ${new Date().toISOString()}`);
		ctx.waitUntil(
			(async () => {
				const data = await runDigest(env);
				const text = buildDigest(data);
				console.log(
					`[meeting-notes] digest — meetings=${data.recentMeetings.length} openItems=${data.openItems.length}`,
				);

				if (env.DIGEST_WEBHOOK) {
					try {
						await fetch(env.DIGEST_WEBHOOK, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								event: "daily_digest",
								generatedAt: new Date().toISOString(),
								openActionItems: data.openItems.length,
								recentMeetings: data.recentMeetings.length,
								text,
							}),
						});
					} catch (err) {
						console.error("[meeting-notes] Digest webhook delivery failed:", err);
					}
				}
			})(),
		);
	},
};
