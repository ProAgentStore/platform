/**
 * invoice-parser — ProAgentStore agent.
 *
 * Stateless API tool that extracts structured data from invoice text using
 * Workers AI, and persists a parse history in a Durable Object for analytics.
 *
 * Routes
 * ------
 * POST /parse        — extract structured fields from invoice text
 * GET  /history      — recent parses with results (default: last 20)
 * GET  /             — health check
 */

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

// ── Types ──────────────────────────────────────────────────────────────────

interface Env {
	AI: Ai;
	HISTORY: DurableObjectNamespace;
	/** Optional: if set, callers must send X-Api-Key: <value> */
	API_KEY?: string;
}

interface LineItem {
	description: string;
	quantity: number | null;
	unit_price: number | null;
	amount: number | null;
}

interface ParsedInvoice {
	vendor: string | null;
	invoice_number: string | null;
	date: string | null;
	due_date: string | null;
	line_items: LineItem[];
	subtotal: number | null;
	tax: number | null;
	total: number | null;
	currency: string | null;
}

interface ParseRecord {
	id: string;
	/** First 200 chars of the submitted text, for display purposes. */
	preview: string;
	result: ParsedInvoice;
	/** Characters in the original input text. */
	inputLength: number;
	parsedAt: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const EXTRACTION_MODEL =
	"@cf/meta/llama-3.3-70b-instruct-fp8-fast" as Parameters<Ai["run"]>[0];

const HISTORY_LIMIT = 20;

// ── Hono API ─────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

/** Get the singleton ParseHistoryDO stub. */
function getHistory(env: Env): DurableObjectStub {
	const id = env.HISTORY.idFromName("store");
	return env.HISTORY.get(id);
}

function doFetch(
	stub: DurableObjectStub,
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return stub.fetch(new Request(`http://internal${path}`, init));
}

/** Optional API key guard — skipped when API_KEY secret is not configured. */
function checkApiKey(env: Env, req: Request): boolean {
	if (!env.API_KEY) return true;
	return req.headers.get("x-api-key") === env.API_KEY;
}

// ── Health ───────────────────────────────────────────────────────────────────

app.get("/", (c) =>
	c.json({ agent: "invoice-parser", type: "tool", status: "ok" }),
);

// ── Parse ────────────────────────────────────────────────────────────────────

app.post("/parse", async (c) => {
	if (!checkApiKey(c.env, c.req.raw)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	let body: { text: string };
	try {
		body = await c.req.json<{ text: string }>();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const { text } = body;
	if (!text || typeof text !== "string" || text.trim().length === 0) {
		return c.json({ error: '"text" is required and must be a non-empty string' }, 400);
	}

	const parsed = await extractInvoice(c.env.AI, text);

	// Persist to history (fire-and-forget — don't block the response)
	const record: ParseRecord = {
		id: crypto.randomUUID(),
		preview: text.slice(0, 200),
		result: parsed,
		inputLength: text.length,
		parsedAt: new Date().toISOString(),
	};

	const stub = getHistory(c.env);
	c.executionCtx.waitUntil(
		doFetch(stub, "/records", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(record),
		}),
	);

	return c.json({ id: record.id, parsedAt: record.parsedAt, result: parsed });
});

// ── History ───────────────────────────────────────────────────────────────────

app.get("/history", async (c) => {
	if (!checkApiKey(c.env, c.req.raw)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const limitParam = c.req.query("limit");
	const limit = limitParam
		? Math.min(Math.max(1, parseInt(limitParam, 10) || HISTORY_LIMIT), 100)
		: HISTORY_LIMIT;

	const stub = getHistory(c.env);
	const res = await doFetch(stub, `/records?limit=${limit}`);
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
 * ParseHistoryDO — singleton that stores the last N parse records.
 *
 * Storage layout:
 *   record:<iso-timestamp>:<id>  → ParseRecord
 *
 * Keys sort lexicographically newest-first when iterated with descending:true.
 */
export class ParseHistoryDO extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		try {
			// POST /records — save a new parse record
			if (path === "/records" && request.method === "POST") {
				const record = await request.json<ParseRecord>();
				const key = `record:${record.parsedAt}:${record.id}`;
				await this.ctx.storage.put(key, record);
				return json(record, 201);
			}

			// GET /records — list recent records, newest first
			if (path === "/records" && request.method === "GET") {
				const limit = parseInt(url.searchParams.get("limit") ?? String(HISTORY_LIMIT), 10);
				const all = await this.ctx.storage.list<ParseRecord>({
					prefix: "record:",
					reverse: true,
					limit,
				});
				const records = [...all.values()];
				return json({ records, total: records.length });
			}

			return json({ error: "Not found" }, 404);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("ParseHistoryDO error:", msg);
			return json({ error: msg }, 500);
		}
	}
}

// ── AI extraction ─────────────────────────────────────────────────────────────

async function extractInvoice(ai: Ai, text: string): Promise<ParsedInvoice> {
	const prompt = `You are an expert invoice data extractor. Extract all structured fields from the invoice text below.

Rules:
- Return ONLY valid JSON — no markdown fences, no explanation, no extra text.
- Use null for any field that is missing or cannot be determined.
- Dates must be in ISO 8601 format (YYYY-MM-DD). If only month/year is present, use the first of the month.
- All monetary values must be plain numbers (no currency symbols, no commas). E.g. 1234.56 not "$1,234.56".
- currency must be a 3-letter ISO 4217 code (USD, EUR, GBP, etc.). Infer from symbols if needed ($ → USD, € → EUR, £ → GBP).
- line_items is an array. Each item has: description (string), quantity (number|null), unit_price (number|null), amount (number|null).
- If there are no line items, return an empty array [].

Respond in exactly this JSON shape:
{
  "vendor": "<string|null>",
  "invoice_number": "<string|null>",
  "date": "<YYYY-MM-DD|null>",
  "due_date": "<YYYY-MM-DD|null>",
  "line_items": [
    { "description": "<string>", "quantity": <number|null>, "unit_price": <number|null>, "amount": <number|null> }
  ],
  "subtotal": <number|null>,
  "tax": <number|null>,
  "total": <number|null>,
  "currency": "<ISO 4217|null>"
}

Invoice text:
---
${text}
---`;

	const empty: ParsedInvoice = {
		vendor: null,
		invoice_number: null,
		date: null,
		due_date: null,
		line_items: [],
		subtotal: null,
		tax: null,
		total: null,
		currency: null,
	};

	try {
		const result = (await ai.run(EXTRACTION_MODEL, {
			messages: [
				{
					role: "system",
					content:
						"You are an invoice data extraction assistant. Output only valid JSON.",
				},
				{ role: "user", content: prompt },
			],
		})) as { response?: string };

		const raw = (result.response ?? "").trim();

		// Tolerate model wrapping output in markdown code fences
		const jsonMatch = raw.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			console.error("AI returned no JSON object. Raw:", raw.slice(0, 300));
			return empty;
		}

		const parsed = JSON.parse(jsonMatch[0]) as Partial<ParsedInvoice>;

		return {
			vendor: str(parsed.vendor),
			invoice_number: str(parsed.invoice_number),
			date: str(parsed.date),
			due_date: str(parsed.due_date),
			line_items: normalizeLineItems(parsed.line_items),
			subtotal: num(parsed.subtotal),
			tax: num(parsed.tax),
			total: num(parsed.total),
			currency: str(parsed.currency),
		};
	} catch (err) {
		console.error(
			"AI extraction failed:",
			err instanceof Error ? err.message : String(err),
		);
		return empty;
	}
}

// ── Normalisation helpers ─────────────────────────────────────────────────────

function str(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	const s = String(v).trim();
	return s.length > 0 ? s : null;
}

function num(v: unknown): number | null {
	if (v === null || v === undefined) return null;
	const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
	return isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function normalizeLineItems(raw: unknown): LineItem[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
		.map((item) => ({
			description: str(item.description) ?? "",
			quantity: num(item.quantity),
			unit_price: num(item.unit_price),
			amount: num(item.amount),
		}));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
